/** Controller module: the human surface and the inter-agent semantics. Talk routing (leader queue, foreground/background delivery via the target session), the agent hierarchy and the talkable-agent manifest, the commander-00001 identity, talk message rendering — plus the swap gate and the /shift, /apps and /talks commands. The handoff machinery itself lives in ./patch.ts. */
import type {
	EntryRenderer,
	ExtensionAPI,
	ExtensionCommandContext,
	MessageRenderer,
	Theme,
} from '@earendil-works/pi-coding-agent';
import { getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import { Markdown, Text, VStack } from '@earendil-works/pi-tui';
import { LEADER_ID } from '@repo/shared/contract';
import type { AppMeta, LeaderTalk } from '@/model';
import type Session from '@/Session';
import type { LiveSession } from '@/Sessions';
import { appSessionsRoot, listAppSessions } from '@/model';
import { installHandoffPatches, offerAdoption, shield, takeShielded } from '@/patch.ts';

/** The human's agent name and description, as other agents see them. */
export const LEADER_AGENT = 'leader';
export const LEADER_DESCRIPTION =
	'Leader that proposes ideas and coordinates works. Can perform UI operations and has environment root access.';

export type TalkableSession = {
	id: string;
	description: string;
	relationship: Relationship;
	recordPath?: string;
};

type Relationship = 'leader' | 'colleague' | 'child';

/** The effective parent of a session: its topic leader when it belongs to a topic, otherwise its spawner. */
function parentOf(meta: AppMeta, id: string): string | undefined {
	const record = meta.sessions[id];
	if (!record) return undefined;
	return record.topic ? record.leaderSessionId : record.parentSessionId;
}

/** Role of `to` as seen by `from`: its leader, colleague, or child; undefined otherwise. */
export function relationship(meta: AppMeta, from: string, to: string): Relationship | undefined {
	if (from === to) return;
	if (parentOf(meta, from) === to) return 'leader';
	if (parentOf(meta, to) === from) return 'child';
	const f = meta.sessions[from];
	const t = meta.sessions[to];
	if (f && t) {
		if (f.topic && f.topic === t.topic) return 'colleague';
		if (
			!f.topic &&
			!t.topic &&
			f.parentSessionId !== undefined &&
			f.parentSessionId === t.parentSessionId
		)
			return 'colleague';
	}
}

/** Render one talkable session's manifest content (unwrapped: the `<agent>` wrapper is added after extensions have transformed the text). */
export function talkableEntry({
	description,
	id,
	recordPath,
	relationship: rel,
}: TalkableSession): string {
	return `<id>${id}</id>
<description>${description}</description>
<relation>${rel}</relation>${recordPath ? `\n<footage>${recordPath}</footage>` : ''}`;
}

/** Sessions `selfId` can talk to (its leader, colleagues, children), leader included. */
export function talkableSessions(
	meta: AppMeta,
	agents: (name: string) => { description: string } | undefined,
	selfId: string,
): Array<TalkableSession> {
	const out: Array<TalkableSession> = [];
	if (relationship(meta, LEADER_ID, selfId) !== undefined)
		out.push({
			description: LEADER_DESCRIPTION,
			id: LEADER_ID,
			relationship: 'leader',
		});

	for (const record of Object.values(meta.sessions)) {
		const rel = relationship(meta, record.id, selfId);
		if (!rel || record.id === selfId) continue;
		out.push({
			description: agents(record.agent)?.description ?? '',
			id: record.id,
			recordPath: record.recordPath,
			relationship: rel,
		});
	}
	return out;
}

/** A talk notice injected into a session's input: `` [talk from `A` (leader)] hi ``. */
export function formatTalkNotice(from: string, rel: string, message: string): string {
	return `[talk from \`${from}\` (${rel})] ${message}`;
}

type EncodedTalk = { content: string; customType: 'talk'; display: true };

/** A talk message for the controller waterfall (rendered by the talk renderer). */
export function encodeTalk(from: string, rel: string, message: string): EncodedTalk {
	return {
		content: JSON.stringify({ from, message, relationship: rel }),
		customType: 'talk',
		display: true,
	};
}

export function decodeTalk(content: string): {
	from: string;
	message: string;
	relationship: string;
} {
	return JSON.parse(content) as { from: string; message: string; relationship: string };
}

/** Render a talk for the controller waterfall: an accent-colored header line over the markdown-rendered message — distinct from thinking text. */
function renderTalkBlock(from: string, rel: string, message: string, theme: Theme): VStack {
	return new VStack(
		[
			new Text(theme.fg('accent', `talk from ${from} (${rel})`)),
			new Markdown(message, 0, 0, getMarkdownTheme()),
		],
		{ gap: 1 },
	);
}

/** Render a talk message delivered into the viewed session. Registered at factory time: the TUI renders session history before session_start fires (renderBeforeBind on every switch), so the renderer must exist by then. */
const renderTalk: MessageRenderer = (message, _options, theme) => {
	const { from, message: msg, relationship: rel } = decodeTalk(message.content as string);
	return renderTalkBlock(from, rel, msg, theme);
};

/** Render a leader-talk entry (a background session's talk, or a /talks replay) for the controller waterfall. A CustomEntry is display-only: unlike the talk message above, it never enters LLM context. */
const renderTalkEntry: EntryRenderer<LeaderTalk> = ({ data }, _options, theme) =>
	data === undefined
		? undefined
		: renderTalkBlock(data.from, data.relationship, data.message, theme);

/** Command context surface used by the shift/apps handlers. */
type CommandContext = Pick<ExtensionCommandContext, 'cwd' | 'ui' | 'newSession' | 'switchSession'>;

export default class Controller {
	/** The interactive session's API; re-bound on every session_start. */
	private pi: ExtensionAPI | undefined;
	/** Talk delivery holds while a session swap is in flight. */
	private shifting: Promise<void> | undefined;

	/** Register the per-session surface at factory time: pi re-runs the extension factory for every session's runner, before the TUI renders history on a switch — commands and the talk renderer exist in time. Any session may register; only the interactive one is attached below. */
	private readonly registerSurface = (pi: ExtensionAPI): void => {
		this.registerCommands(pi);
		pi.registerMessageRenderer('talk', renderTalk);
		pi.registerEntryRenderer('talk', renderTalkEntry);
	};

	/** Attach the human surface to the interactive session (per session_start). */
	private readonly attachSession = (pi: ExtensionAPI): void => {
		this.pi = pi;
	};

	/** Route a talk: leader queue, or delivery into the target session. Only the routing is awaited (shift gate, validation, leader-queue write); the delivery itself is fired and forgotten — the talker's turn ends once the intent is recorded, and the target's turn is the target's own. */
	private readonly deliverTalk = async (
		from: string,
		to: string,
		message: string,
	): Promise<void> => {
		// Hold delivery while the controller swaps sessions: a talk landing mid-swap Could otherwise lazily create a background session racing the swap onto The same record (one-writer violation).
		if (this.shifting !== undefined) await this.shifting;
		const meta = this.ctx.meta();
		// The role of `from` as seen by `to`.
		const rel = relationship(meta, to, from) ?? 'colleague';
		if (to === LEADER_ID) {
			const talk = { at: new Date().toISOString(), from, message, relationship: rel };
			this.ctx.mutateMeta((m) => {
				(m.leaderTalks ??= []).push(talk);
			});
			// The viewed session's own talks surface through the talk tool Result; background talks surface as a waterfall entry here.
			if (this.ctx.viewing() !== from) this.pi?.appendEntry('talk', talk);
			return;
		}
		const session = await this.ctx.ensureLive(to);
		session.deliver(from, rel, message);
	};

	/** Human input = the leader talking to the viewed session. */
	private readonly formatLeaderTalk = (sessionId: string, text: string): string => {
		const meta = this.ctx.meta();
		const rel = relationship(meta, sessionId, LEADER_ID) ?? 'leader';
		return formatTalkNotice(LEADER_ID, rel, text);
	};

	/** The talkable manifest for one session: each roster entry rendered as plain text, dispatched through the entry's own session so its extensions may transform it, then wrapped per agent. */
	private readonly talkableFor = (selfId: string): Array<string> => {
		const meta = this.ctx.meta();
		const roster = talkableSessions(meta, (name) => this.ctx.get(name), selfId);
		const out: Array<string> = [];
		for (const entry of roster) {
			let content = talkableEntry(entry);
			const session = this.ctx.sessionOf(entry.id);
			if (session !== undefined) content = session.info(content);
			out.push(`<agent>\n${content}\n</agent>`);
		}
		return out;
	};

	/** Run a session swap with talk delivery held until it settles. */
	private readonly withShifting = async (fn: () => Promise<unknown>): Promise<void> => {
		let release!: () => void;
		this.shifting = new Promise<void>((settle) => {
			release = settle;
		});
		try {
			await fn();
		} finally {
			this.shifting = undefined;
			release();
		}
	};

	/** /shift → pick a session (or new agent) in this application session. */
	private readonly shift = async (ctx: CommandContext): Promise<void> => {
		const meta =
			this.ctx.appFolder() === undefined
				? (await listAppSessions(appSessionsRoot(ctx.cwd)))[0]
				: this.ctx.meta();
		if (meta === undefined) {
			await this.shiftNew(ctx);
			return;
		}
		const picked = await ctx.ui.select('Shift to session', [
			...Object.keys(meta.sessions),
			'new',
		]);
		if (picked === 'new') {
			await this.shiftNew(ctx);
			return;
		}
		const record = picked === undefined ? undefined : meta.sessions[picked];
		if (record === undefined) return;
		// Adopt the target's live session: the controller hosts it as-is (mid-generation included) instead of opening its record. session_start (re-fired by the rebind) binds and marks it viewed.
		await this.shiftAway(ctx, async () => {
			const live = this.ctx.takeLive(record.id);
			if (live !== undefined) offerAdoption(record.recordPath, live);
			await ctx.switchSession(record.recordPath);
		});
	};

	/** /shift → new: pick an agent, arm it, swap to a fresh session. */
	private readonly shiftNew = async (ctx: CommandContext): Promise<void> => {
		const agent = await ctx.ui.select('New agent', this.ctx.names());
		if (agent === undefined) return;
		// Shifting with no active app session starts a new one.
		if (this.ctx.appFolder() === undefined)
			await this.ctx.beginAppSession(appSessionsRoot(ctx.cwd));
		this.ctx.armPending(agent);
		await this.ctx.rememberDefault(agent);
		// Session_start('new') binds provisionally.
		await this.shiftAway(ctx, () => ctx.newSession());
	};

	/** Swap sessions while preserving the controller's in-flight turn: shield the viewed session through teardown, then adopt the captured session as a background session. */
	private readonly shiftAway = async (
		ctx: CommandContext,
		swap: () => Promise<unknown>,
	): Promise<void> => {
		await installHandoffPatches();
		const viewing = this.ctx.viewing();
		if (viewing !== undefined) {
			const record = this.ctx.meta().sessions[viewing];
			if (record !== undefined) shield(record.recordPath);
		}
		await this.withShifting(swap);
		const live = takeShielded();
		if (live !== undefined && viewing !== undefined) this.ctx.putLive(viewing, live);
	};

	/** /apps → pick an application session to resume, or start a new one. */
	private readonly apps = async (ctx: CommandContext): Promise<void> => {
		await installHandoffPatches();
		// Only app sessions the leader actually spoke to; label by the first message.
		const usable = (await listAppSessions(appSessionsRoot(ctx.cwd))).filter(
			(meta): meta is AppMeta & { firstMessage: string } => meta.firstMessage !== undefined,
		);
		// Disambiguate duplicate labels.
		const seen = new Map<string, number>();
		const labels = usable.map((meta) => {
			const count = (seen.get(meta.firstMessage) ?? 0) + 1;
			seen.set(meta.firstMessage, count);
			return `${meta.firstMessage}${count > 1 ? ` #${count}` : ''} (${Object.keys(meta.sessions).length} agents)`;
		});
		labels.push('new');
		const picked = await ctx.ui.select('Application session', labels);
		if (picked === undefined) return;
		const meta = picked === 'new' ? undefined : usable[labels.indexOf(picked)];
		if (picked !== 'new' && meta === undefined) return;
		const target =
			meta === undefined
				? undefined
				: ((meta.currentViewingSessionId === undefined
						? undefined
						: meta.sessions[meta.currentViewingSessionId]) ??
					Object.values(meta.sessions)[0]);
		await this.withShifting(async () => {
			// Offer the target's live session before reset: reset disposes the rest.
			if (target !== undefined) {
				const live = this.ctx.takeLive(target.id);
				if (live !== undefined) offerAdoption(target.recordPath, live);
			}
			if (meta === undefined) await this.ctx.beginAppSession(appSessionsRoot(ctx.cwd));
			else {
				this.ctx.reset();
				this.ctx.activate(meta);
			}
			if (target === undefined) {
				this.ctx.armPending((await this.ctx.defaultAgent()) ?? '');
				await ctx.newSession();
				return;
			}
			await ctx.switchSession(target.recordPath);
		});
	};

	/** /talks → replay the talks received by the leader into the waterfall as custom entries: rendered by renderTalkEntry, never sent to the model. */
	private readonly talks = (): void => {
		if (this.ctx.appFolder() === undefined || this.pi === undefined) return;
		const meta = this.ctx.meta();
		for (const talk of meta.leaderTalks ?? []) this.pi.appendEntry('talk', talk);
	};

	private readonly registerCommands = (pi: ExtensionAPI): void => {
		pi.registerCommand('shift', {
			description: 'Shift between agent sessions in this application session',
			handler: async (_args, ctx) => {
				await this.shift(ctx);
			},
		});
		pi.registerCommand('apps', {
			description: 'Browse application sessions (resume or start new)',
			handler: async (_args, ctx) => {
				await this.apps(ctx);
			},
		});
		pi.registerCommand('talks', {
			description: 'Show talks received by the leader',
			handler: () => Promise.resolve(this.talks()),
		});
	};

	constructor(
		private readonly ctx: {
			viewing: () => string | undefined;
			appFolder: () => string | undefined;
			meta: () => AppMeta;
			mutateMeta: (fn: (meta: AppMeta) => void) => AppMeta;
			ensureLive: (sessionId: string) => Promise<Session>;
			sessionOf: (id: string) => Session | undefined;
			get: (name: string) => { description: string } | undefined;
			putLive: (id: string, live: LiveSession) => void;
			takeLive: (id: string) => LiveSession | undefined;
			armPending: (agent: string) => void;
			activate: (meta: AppMeta) => void;
			beginAppSession: (root: string) => Promise<void>;
			reset: () => void;
			names: () => Array<string>;
			defaultAgent: () => Promise<string | undefined>;
			rememberDefault: (agent: string) => Promise<void>;
		},
	) {
		// Fire-and-forget: every swap path awaits it before tearing down.
		void installHandoffPatches();
	}

	root = {
		/** Attach the human surface to the interactive session (per session_start). */
		attachSession: this.attachSession,
		deliverTalk: this.deliverTalk,
		formatLeaderTalk: this.formatLeaderTalk,
		offerAdoption,
		registerSurface: this.registerSurface,
		shield,
		takeShielded,
		talkableFor: this.talkableFor,
		withShifting: this.withShifting,
	};
}

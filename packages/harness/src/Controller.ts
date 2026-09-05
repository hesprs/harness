/**
 * Controller module: the human surface. Talk routing (leader queue, foreground
 * delivery, background steer/prompt), the /shift, /apps and /talks commands,
 * the talk message renderer — plus the swap gate, which exist only to serve
 * shifting. The handoff machinery lives in ./patch.ts.
 *
 * The human surface attaches per interactive session: pi hands every session
 * a fresh ExtensionAPI (a resumed /apps session included), so commands, the
 * talk renderer and foreground delivery re-bind on each session_start.
 */
import type {
	EntryRenderer,
	ExtensionAPI,
	ExtensionCommandContext,
	MessageRenderer,
} from '@earendil-works/pi-coding-agent';
import { getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import { Markdown } from '@earendil-works/pi-tui';
import { LEADER_ID } from '@repo/shared/contract';
import type { AppMeta, LeaderTalk } from '@/model';
import type { LiveSession } from '@/Sessions';
import {
	MetaStore,
	appSessionsRoot,
	decodeTalk,
	encodeTalk,
	formatTalkNotice,
	listAppSessions,
	relationship,
} from '@/model';
import { installHandoffPatches, offerAdoption, shield, takeShielded } from '@/patch.ts';

/** Render a talk message for the controller waterfall. Registered at
 * factory time: the TUI renders session history before session_start fires
 * (renderBeforeBind on every switch), so the renderer must exist by then. */
const renderTalk: MessageRenderer = (message) => {
	const { from, message: msg, relationship: rel } = decodeTalk(message.content as string);
	return new Markdown(`**${from}** (${rel})\n\n${msg}`, 0, 0, getMarkdownTheme());
};

/** Render a replayed leader talk for the controller waterfall. A CustomEntry
 * is display-only: unlike the talk message above, it never enters LLM context. */
const renderTalkEntry: EntryRenderer<LeaderTalk> = ({ data }) =>
	data &&
	new Markdown(
		`**${data.from}** (${data.relationship})\n\n${data.message}`,
		0,
		0,
		getMarkdownTheme(),
	);

/** Command context surface used by the shift/apps handlers. */
type CommandContext = Pick<ExtensionCommandContext, 'cwd' | 'ui' | 'newSession' | 'switchSession'>;

export default class Controller {
	private notify: ((message: string) => void) | undefined;
	/** The interactive session's API; re-bound on every session_start. */
	private pi: ExtensionAPI | undefined;
	/** Talk delivery holds while a session swap is in flight. */
	private shifting: Promise<void> | undefined;

	/** Register the per-session surface at factory time: pi re-runs the
	 * extension factory for every session's runner, before the TUI renders
	 * history on a switch — commands and the talk renderer exist in time.
	 * Any session may register; only the interactive one is attached below. */
	private readonly registerSurface = (pi: ExtensionAPI): void => {
		this.registerCommands(pi);
		pi.registerMessageRenderer('talk', renderTalk);
		pi.registerEntryRenderer('talk', renderTalkEntry);
	};

	/** Attach the human surface to the interactive session (per session_start). */
	private readonly attachSession = (
		pi: ExtensionAPI,
		ctx: { ui: { notify: (message: string) => void } },
	): void => {
		this.pi = pi;
		this.notify = ctx.ui.notify;
	};

	/** Route a talk: leader queue, foreground delivery, or background
	 * steer/prompt. Only the routing is awaited (shift gate, validation,
	 * leader-queue write); the delivery itself is fired and forgotten —
	 * the talker's turn ends once the intent is recorded, and the target's
	 * turn is the target's own. */
	private readonly deliverTalk = async (
		from: string,
		to: string,
		message: string,
	): Promise<void> => {
		// Hold delivery while the controller swaps sessions: a talk landing mid-swap
		// Could otherwise lazily create a background session racing the swap onto
		// The same record (one-writer violation).
		if (this.shifting !== undefined) await this.shifting;
		const meta = await this.ctx.meta();
		// The role of `from` as seen by `to`.
		const rel = relationship(meta, to, from) ?? 'colleague';
		if (to === LEADER_ID) {
			await this.ctx.mutateMeta((m) => {
				(m.leaderTalks ??= []).push({
					at: new Date().toISOString(),
					from,
					message,
					relationship: rel,
				});
			});
			this.notify?.(`\`${from}\`: ${message}`);
			return;
		}
		if (to === this.ctx.viewing()) {
			this.pi?.sendMessage(encodeTalk(from, rel, message), {
				deliverAs: 'steer',
				triggerTurn: true,
			});
			return;
		}
		const notice = formatTalkNotice(from, rel, message);
		const session = await this.ctx.liveFor(to);
		// 'extension' source: the target's own input handler must not mistake
		// The notice for human input and wrap it again as a leader talk.
		void (session.isStreaming
			? session.steer(notice)
			: session.prompt(notice, { source: 'extension' }));
	};

	/** Human input = the leader talking to the viewed session. */
	private readonly formatLeaderTalk = async (
		sessionId: string,
		text: string,
	): Promise<string> => {
		const meta = await this.ctx.meta();
		const rel = relationship(meta, sessionId, LEADER_ID) ?? 'leader';
		return formatTalkNotice(LEADER_ID, rel, text);
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
		const active = this.ctx.appFolder();
		const folder = active ?? (await listAppSessions(appSessionsRoot(ctx.cwd)))[0]?.appFolder;
		if (folder === undefined) {
			await this.shiftNew(ctx);
			return;
		}
		const meta = await new MetaStore(folder).read();
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
		// Adopt the target's live session: the controller hosts it as-is
		// (mid-generation included) instead of opening its record. session_start
		// (re-fired by the rebind) binds and marks it viewed.
		await this.shiftAway(ctx, async () => {
			const live = this.ctx.takeBackground(record.id);
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

	/**
	 * Swap sessions while preserving the controller's in-flight turn: shield
	 * the viewed session through teardown, then adopt the captured session as
	 * a background session.
	 */
	private readonly shiftAway = async (
		ctx: CommandContext,
		swap: () => Promise<unknown>,
	): Promise<void> => {
		await installHandoffPatches();
		const viewing = this.ctx.viewing();
		if (viewing !== undefined) {
			const record = (await this.ctx.meta()).sessions[viewing];
			if (record !== undefined) shield(record.recordPath);
		}
		await this.withShifting(swap);
		const live = takeShielded();
		if (live !== undefined && viewing !== undefined) this.ctx.putBackground(viewing, live);
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
				const live = this.ctx.takeBackground(target.id);
				if (live !== undefined) offerAdoption(target.recordPath, live);
			}
			if (meta === undefined) await this.ctx.beginAppSession(appSessionsRoot(ctx.cwd));
			else {
				this.ctx.reset();
				this.ctx.activate(meta.appFolder);
			}
			if (target === undefined) {
				this.ctx.armPending((await this.ctx.defaultAgent()) ?? '');
				await ctx.newSession();
				return;
			}
			await ctx.switchSession(target.recordPath);
		});
	};

	/** /talks → replay the talks received by the leader into the waterfall as
	 * custom entries: rendered by renderTalkEntry, never sent to the model. */
	private readonly talks = async (): Promise<void> => {
		if (this.ctx.appFolder() === undefined || this.pi === undefined) return;
		const meta = await this.ctx.meta();
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
			handler: async () => {
				await this.talks();
			},
		});
	};

	constructor(
		private readonly ctx: {
			viewing: () => string | undefined;
			appFolder: () => string | undefined;
			meta: () => Promise<AppMeta>;
			mutateMeta: (fn: (meta: AppMeta) => void) => Promise<AppMeta>;
			liveFor: (sessionId: string) => Promise<LiveSession>;
			putBackground: (id: string, live: LiveSession) => void;
			takeBackground: (id: string) => LiveSession | undefined;
			armPending: (agent: string) => void;
			activate: (appFolder: string) => void;
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
		withShifting: this.withShifting,
	};
}

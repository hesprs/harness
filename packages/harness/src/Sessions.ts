import { LEADER_ID } from '@repo/shared/contract';
import { existsSync, watch } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { AppMeta, SessionRecord } from '@/model';
import type { PromptSection } from '@/Prompt';
import { registry } from '@/Agents';
import {
	MetaStore,
	createAppSession,
	listAppSessions,
	newSessionId,
	recordByPath,
	registerSession,
	talkableSessions,
	topicCascade,
} from '@/model';
/**
 * Sessions module: the session world. Owns the active application session,
 * the viewed session, the pending agent, pi-session identity bindings and
 * the live background sessions — plus every session lifecycle operation:
 * bind-by-file, controller registration, spawn, background session creation,
 * and watcher-driven deletion: deleting a session's record file (or a topic
 * file) aborts the affected sessions. Registers the identity, topic, note and
 * talkable prompt sections.
 */
import { hostPi } from '@/patch.ts';
import { talkableEntry } from '@/Prompt';

export type SessionBinding = {
	sessionId: string;
	agent: string;
	appFolder: string;
	recordPath: string;
	topic?: string;
};

/** A watched directory: file names whose removal fires a handler. */
type TrackedDir = { close: () => void; handlers: Map<string, () => void> };

export type LiveSession = {
	dispose: () => void;
	isStreaming: boolean;
	/** `source: 'extension'` keeps programmatic prompts out of the target's
	 * human-input transform. */
	prompt: (text: string, options?: { source: 'extension' }) => Promise<void>;
	steer: (text: string) => Promise<void>;
	sessionManager: { getSessionFile: () => string | undefined };
};

function bindingOf(folder: string, record: SessionRecord): SessionBinding {
	return {
		agent: record.agent,
		appFolder: folder,
		recordPath: record.recordPath,
		sessionId: record.id,
		...(record.topic === undefined ? {} : { topic: record.topic }),
	};
}

function identitySection(ctx: {
	now: Date;
	lastInvocation?: Date;
	appFolder: string;
	sessionId: string;
	topicPath?: string;
}): string {
	const lines = [`Current date: \`${ctx.now.toISOString()}\``];
	if (ctx.lastInvocation !== undefined) {
		const seconds = Math.round((ctx.now.getTime() - ctx.lastInvocation.getTime()) / 1000);
		lines.push(`Time since last invocation: ${seconds} seconds`);
	}
	lines.push(`Application session: \`${ctx.appFolder}\``, `Your ID: \`${ctx.sessionId}\``);
	if (ctx.topicPath !== undefined) lines.push(`Topic: \`${ctx.topicPath}\``);
	return lines.join('\n');
}

async function topicSection(ctx: { topicPath?: string }): Promise<string> {
	if (ctx.topicPath === undefined) return '';
	try {
		return await Bun.file(ctx.topicPath).text();
	} catch {
		return '';
	}
}

async function noteSection(ctx: {
	appFolder: string;
	sessionId: string;
	canEditNote: boolean;
}): Promise<string> {
	const notePath = join(ctx.appFolder, `${ctx.sessionId}.md`);
	const content = await Bun.file(notePath)
		.text()
		.catch(() => '');
	return `Personal note is at \`${notePath}\`.${ctx.canEditNote ? ' You can edit this note with your file tools; use it for TODOs and handoff notes; the note manifests what you are doing to other agents.' : ''}${content ? ` Note content:\n\n${content}` : ''}`;
}

export default class Sessions {
	private appFolder: string | undefined;
	private currentViewing: string | undefined;
	private pendingAgent: string | undefined;
	/** Record located in the app folder for the pending controller session. */
	private pendingRecord: { recordPath: string; sessionId: string } | undefined;
	private cwd: string | undefined;
	private readonly bindings = new Map<string, SessionBinding>();
	private readonly background = new Map<string, LiveSession>();
	private readonly trackedDirs = new Map<string, TrackedDir>();

	private readonly talkable = async (ctx: { sessionId: string }): Promise<string> => {
		try {
			const meta = await this.readMeta();
			const list = await talkableSessions(meta, (name) => registry.get(name), ctx.sessionId);
			return list.map(talkableEntry).join('\n');
		} catch {
			return ''; // Meta unavailable: talk tool still registered
		}
	};

	/** Bind the pi session owning `file`: the record matching it in the active
	 * app session or any app session under `root` — records opened outside
	 * our commands (native /resume, `pi -r`) still bind. */
	private readonly bindByFile = async (
		piSessionId: string,
		file: string,
		root: string,
	): Promise<SessionBinding | undefined> => {
		const folders = this.appFolder === undefined ? [] : [this.appFolder];
		for (const meta of await listAppSessions(root)) folders.push(meta.appFolder);
		for (const folder of new Set(folders)) {
			const record = recordByPath(await new MetaStore(folder).read(), file);
			if (record === undefined) continue;
			this.appFolder = folder;
			this.pendingAgent = undefined;
			this.pendingRecord = undefined;
			this.currentViewing = record.id;
			const bound = bindingOf(folder, record);
			this.bindings.set(piSessionId, bound);
			this.watchSession(record);
			return bound;
		}
		return undefined;
	};

	/** Provision the pending controller session: locate its record file inside
	 * the active app session (pi allocates session files in the default
	 * sessions dir; the host adapter relocates them). */
	private readonly provisionPending = (
		agent: string,
	): { recordPath: string; sessionId: string } => {
		if (this.pendingRecord === undefined) {
			if (this.appFolder === undefined) throw new Error('no application session');
			const sessionId = newSessionId(agent);
			this.pendingRecord = {
				recordPath: join(this.appFolder, `${sessionId}.jsonl`),
				sessionId,
			};
		}
		return this.pendingRecord;
	};

	/** Register the controller session as a fresh agent session (leader's
	 * child): note + record, on the first user message. */
	private readonly registerViewing = async (opts: {
		piSessionId: string;
		agent: string;
		topic?: string;
	}): Promise<SessionBinding> => {
		if (this.appFolder === undefined) throw new Error('no application session');
		const { recordPath, sessionId } = this.provisionPending(opts.agent);
		const notePath = join(this.appFolder, `${sessionId}.md`);
		await Bun.write(notePath, '');
		let record!: SessionRecord;
		await this.writeMeta((meta) => {
			record = registerSession(meta, {
				agent: opts.agent,
				notePath,
				recordPath,
				sessionId,
				spawnerId: LEADER_ID,
				...(opts.topic === undefined ? {} : { topic: opts.topic }),
			});
			meta.currentViewingSessionId = sessionId;
		});
		this.currentViewing = sessionId;
		this.pendingAgent = undefined;
		this.pendingRecord = undefined;
		const bound = bindingOf(this.appFolder ?? '', record);
		this.bindings.set(opts.piSessionId, bound);
		this.watchSession(record);
		return bound;
	};

	/** The app session's display name: the first user message, untransformed. */
	private readonly captureFirstMessage = async (text: string): Promise<void> => {
		if (this.appFolder === undefined) return;
		const meta = await this.readMeta();
		if (meta.firstMessage !== undefined) return;
		const firstLine = text.split('\n')[0]?.slice(0, 80).trim();
		if (firstLine === undefined || firstLine === '') return;
		await this.writeMeta((m) => {
			m.firstMessage = firstLine;
		});
	};

	private readonly spawn = async (
		from: string,
		agent: string,
		topic?: string,
	): Promise<{ sessionId: string; recordPath: string }> => {
		if (this.appFolder === undefined || this.cwd === undefined)
			throw new Error('no application session');
		const sessionId = newSessionId(agent);
		const recordPath = join(this.appFolder, `${sessionId}.jsonl`);
		const notePath = join(this.appFolder, `${sessionId}.md`);
		await Bun.write(notePath, '');
		let record!: SessionRecord;
		await this.writeMeta((meta) => {
			record = registerSession(meta, {
				agent,
				notePath,
				recordPath,
				sessionId,
				spawnerId: from,
				...(topic === undefined ? {} : { topic }),
			});
		});
		const session = await this.createBackground(record);
		this.background.set(sessionId, session);
		return { recordPath, sessionId };
	};

	/** The live session for a harness session id, creating one on demand. */
	private readonly liveFor = async (sessionId: string): Promise<LiveSession> => {
		const existing = this.background.get(sessionId);
		if (existing !== undefined) return existing;
		const record = (await this.readMeta()).sessions[sessionId];
		if (record === undefined) throw new Error(`unknown session: ${sessionId}`);
		const session = await this.createBackground(record);
		this.background.set(sessionId, session);
		return session;
	};

	/** Run `onGone` when `path` disappears: one directory watcher per parent
	 * directory, tracking the file names of interest. */
	private readonly track = (path: string, onGone: () => void): void => {
		const abs = resolve(path);
		const dir = dirname(abs);
		const existing = this.trackedDirs.get(dir);
		if (existing !== undefined) {
			existing.handlers.set(basename(abs), onGone);
			return;
		}
		try {
			const handlers = new Map<string, () => void>();
			const watcher = watch(dir, { persistent: false }, (event, file) => {
				const name = file ?? undefined;
				if (event !== 'rename' || name === undefined) return;
				const fire = handlers.get(name);
				if (fire !== undefined && !existsSync(join(dir, name))) {
					handlers.delete(name);
					fire();
				}
			});
			handlers.set(basename(abs), onGone);
			this.trackedDirs.set(dir, { close: () => watcher.close(), handlers });
		} catch {
			// Parent directory missing: nothing to watch.
		}
	};

	/** Watch a session's record file and topic file: deleting either aborts
	 * the session — a topic deletion cascades over the whole topic. */
	private readonly watchSession = (record: SessionRecord): void => {
		this.track(record.recordPath, () => void this.abortRecord(record.recordPath));
		const topic = record.topic;
		if (topic !== undefined) this.track(topic, () => void this.abortTopic(topic));
	};

	/** A session's record file disappeared: erase the session. A missing
	 * meta means the whole app folder went — nothing left to erase. */
	private readonly abortRecord = async (path: string): Promise<void> => {
		const meta = await this.readMeta().catch(() => {});
		if (meta === undefined) return;
		const record = recordByPath(meta, path);
		if (record !== undefined) await this.erase(record);
	};

	/** A topic file disappeared: erase the topic's members and descendants. */
	private readonly abortTopic = async (topic: string): Promise<void> => {
		const meta = await this.readMeta().catch(() => {});
		if (meta === undefined) return;
		for (const id of topicCascade(meta, topic)) {
			const record = meta.sessions[id];
			if (record !== undefined) await this.erase(record);
		}
	};

	/** Start a new application session: tear down the old one, create the
	 * folder. The single creation point — every new-app-session flow goes
	 * through here. */
	private readonly beginAppSession = async (root: string): Promise<void> => {
		this.reset();
		this.appFolder = (await createAppSession(root)).appFolder;
	};

	private readonly reset = (): void => {
		for (const session of this.background.values()) session.dispose();
		this.background.clear();
		this.bindings.clear();
		for (const dir of this.trackedDirs.values()) dir.close();
		this.trackedDirs.clear();
		this.appFolder = undefined;
		this.currentViewing = undefined;
		this.pendingAgent = undefined;
		this.pendingRecord = undefined;
	};

	private readonly readMeta = (): Promise<AppMeta> => {
		if (this.appFolder === undefined)
			return Promise.reject(new Error('no application session'));
		return new MetaStore(this.appFolder).read();
	};

	private readonly writeMeta = (fn: (meta: AppMeta) => void): Promise<AppMeta> => {
		if (this.appFolder === undefined)
			return Promise.reject(new Error('no application session'));
		return new MetaStore(this.appFolder).mutate(fn);
	};

	/** Create a background SDK session continuing `record` and bind its identity.
	 * Built from the host's module so the session can later be adopted by the
	 * interactive runtime (see ./patch.ts). */
	private async createBackground(record: SessionRecord): Promise<LiveSession> {
		if (this.appFolder === undefined || this.cwd === undefined)
			throw new Error('no application session');
		this.watchSession(record);
		const pi = await hostPi();
		const sessionManager = pi.SessionManager.open(record.recordPath, undefined, this.cwd);
		this.bindings.set(sessionManager.getSessionId(), bindingOf(this.appFolder, record));
		const { session } = await pi.createAgentSession({ cwd: this.cwd, sessionManager });
		// CreateAgentSession runs extension factories but never emits session_start.
		await session.bindExtensions({});
		return session;
	}

	/** Remove a session: live instance, record + note files, and meta entry. */
	private async erase(record: SessionRecord): Promise<void> {
		this.background.get(record.id)?.dispose();
		this.background.delete(record.id);
		await rm(record.recordPath, { force: true });
		await rm(record.notePath, { force: true });
		await this.writeMeta((m) => {
			delete m.sessions[record.id];
		});
	}

	constructor(ctx: { registerSection: (section: PromptSection) => void }) {
		ctx.registerSection({
			priority: 100,
			render: identitySection,
		});
		ctx.registerSection({
			priority: 200,
			render: topicSection,
			title: 'Topic Context',
		});
		ctx.registerSection({
			priority: 300,
			render: noteSection,
			title: 'Personal Note',
		});
		ctx.registerSection({
			priority: 500,
			render: this.talkable,
			title: 'Other Agents (Talkable)',
		});
	}

	root = {
		activate: (appFolder: string): void => {
			this.appFolder = appFolder;
		},
		appFolder: (): string | undefined => this.appFolder,
		armPending: (agent: string): void => {
			this.pendingAgent = agent;
			this.pendingRecord = undefined;
		},
		backgroundOf: (id: string): LiveSession | undefined => this.background.get(id),
		beginAppSession: this.beginAppSession,
		bindByFile: this.bindByFile,
		bindingOf: (piSessionId: string): SessionBinding | undefined =>
			this.bindings.get(piSessionId),
		captureFirstMessage: this.captureFirstMessage,
		liveFor: this.liveFor,
		meta: this.readMeta,
		mutateMeta: this.writeMeta,
		pendingAgent: (): string | undefined => this.pendingAgent,
		provisionPending: this.provisionPending,
		putBackground: (id: string, live: LiveSession): void => {
			this.background.set(id, live);
		},
		registerViewing: this.registerViewing,
		reset: this.reset,
		spawn: this.spawn,
		takeBackground: (id: string): LiveSession | undefined => {
			const live = this.background.get(id);
			this.background.delete(id);
			return live;
		},
		/** The controller cwd, used to create background sessions. */
		useCwd: (cwd: string): void => {
			this.cwd = cwd;
		},
		viewing: (): string | undefined => this.currentViewing,
	};
}

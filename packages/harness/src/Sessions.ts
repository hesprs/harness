import {
	createAppSession,
	listAppSessions,
	newSessionId,
	persistMeta,
	recordByPath,
	registerSession,
	topicCascade,
} from '@/model';
import { hostPi } from '@/patch.ts';
import { LEADER_ID } from '@repo/shared/contract';
import { watch } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { AppMeta, SessionRecord } from '@/model';
import type Session from '@/Session';

/**
 * Sessions module: the session world. Owns the active application session, the viewed session, the
 * pending agent, pi-session identity bindings, the live agent sessions — plus every session
 * lifecycle operation: bind-by-file, controller registration, spawn, on-demand background session
 * creation, and watcher-driven deletion: deleting a session's record file (or a topic file) aborts
 * the affected sessions.
 */

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
	/** `source: 'extension'` keeps programmatic prompts out of the target's human-input transform. */
	prompt: (text: string, options?: { source: 'extension' }) => Promise<void>;
	steer: (text: string) => Promise<string>;
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

export default class Sessions {
	/**
	 * The active application session's meta — seeded from disk once (at activation or creation),
	 * mutated in memory, persisted fire-and-forget.
	 */
	private meta: AppMeta | undefined;
	private get appFolder(): string | undefined {
		return this.meta?.appFolder;
	}
	private currentViewing: string | undefined;
	private pendingAgent: string | undefined;
	/** Record located in the app folder for the pending controller session. */
	private pendingRecord: { recordPath: string; sessionId: string } | undefined;
	private cwd: string | undefined;
	private readonly bindings = new Map<string, SessionBinding>();
	private readonly sessions = new Map<string, Session>();
	private readonly trackedDirs = new Map<string, TrackedDir>();

	/**
	 * Bind the pi session owning `file`: the record matching it in the active app session or any
	 * app session under `root` — records opened outside our commands (native /resume, `pi -r`)
	 * still bind.
	 */
	private readonly bindByFile = async (
		piSessionId: string,
		file: string,
		root: string,
	): Promise<SessionBinding | undefined> => {
		const candidates: Array<AppMeta> = this.meta === undefined ? [] : [this.meta];
		for (const listed of await listAppSessions(root)) candidates.push(listed);
		for (const meta of candidates) {
			const record = recordByPath(meta, file);
			if (record === undefined) continue;
			this.meta = meta;
			this.pendingAgent = undefined;
			this.pendingRecord = undefined;
			this.currentViewing = record.id;
			const bound = bindingOf(meta.appFolder, record);
			this.bindings.set(piSessionId, bound);
			this.watchSession(record);
			return bound;
		}
		return undefined;
	};

	/**
	 * Provision the pending controller session: locate its record file inside the active app
	 * session (pi allocates session files in the default sessions dir; the session relocates
	 * them).
	 */
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

	/**
	 * Register the controller session as a fresh agent session (leader's child) on the first user
	 * message.
	 */
	private readonly registerViewing = (opts: {
		piSessionId: string;
		agent: string;
		topic?: string;
	}): SessionBinding => {
		if (this.appFolder === undefined) throw new Error('no application session');
		const { recordPath, sessionId } = this.provisionPending(opts.agent);
		let record!: SessionRecord;
		this.writeMeta((meta) => {
			record = registerSession(meta, {
				agent: opts.agent,
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
		const bound = bindingOf(this.appFolder, record);
		this.bindings.set(opts.piSessionId, bound);
		this.watchSession(record);
		return bound;
	};

	/** The app session's display name: the first user message, untransformed. */
	private readonly captureFirstMessage = (text: string): void => {
		const meta = this.meta;
		if (meta === undefined || meta.firstMessage !== undefined) return;
		const firstLine = text.split('\n')[0]?.slice(0, 80).trim();
		if (firstLine === undefined || firstLine === '') return;
		this.writeMeta((m) => {
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
		let record!: SessionRecord;
		this.writeMeta((meta) => {
			record = registerSession(meta, {
				agent,
				recordPath,
				sessionId,
				spawnerId: from,
				...(topic === undefined ? {} : { topic }),
			});
		});
		const live = await this.createBackground(record);
		this.sessions.get(sessionId)?.attachLive(live);
		return { recordPath, sessionId };
	};

	/**
	 * The live session for a harness session id: the viewed session itself, an attached background
	 * session, or one created on demand.
	 */
	private readonly ensureLive = async (sessionId: string): Promise<Session> => {
		const existing = this.sessions.get(sessionId);
		if (this.currentViewing === sessionId && existing !== undefined) return existing;
		if (existing?.live !== undefined) return existing;
		const record = this.readMeta().sessions[sessionId];
		if (record === undefined) throw new Error(`unknown session: ${sessionId}`);
		const live = await this.createBackground(record);
		const session = this.sessions.get(sessionId);
		if (session === undefined) {
			live.dispose();
			throw new Error(`session did not bind: ${sessionId}`);
		}
		session.attachLive(live);
		return session;
	};

	/**
	 * Run `onGone` when `path` disappears: one directory watcher per parent directory, tracking the
	 * file names of interest.
	 */
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
				if (fire !== undefined)
					void (async () => {
						if (!(await Bun.file(join(dir, name)).exists())) {
							handlers.delete(name);
							fire();
						}
					})();
			});
			handlers.set(basename(abs), onGone);
			this.trackedDirs.set(dir, { close: () => watcher.close(), handlers });
		} catch {
			// Parent directory missing: nothing to watch.
		}
	};

	/**
	 * Watch a session's record file and topic file: deleting either aborts the session — a topic
	 * deletion cascades over the whole topic.
	 */
	private readonly watchSession = (record: SessionRecord): void => {
		this.track(record.recordPath, () => void this.abortRecord(record.recordPath));
		const topic = record.topic;
		if (topic !== undefined) this.track(topic, () => void this.abortTopic(topic));
	};

	/**
	 * A session's record file disappeared: erase the session. A missing meta means the whole app
	 * folder went — nothing left to erase.
	 */
	private readonly abortRecord = async (path: string): Promise<void> => {
		const meta = this.meta;
		if (meta === undefined) return;
		const record = recordByPath(meta, path);
		if (record !== undefined) await this.erase(record);
	};

	/** A topic file disappeared: erase the topic's members and descendants. */
	private readonly abortTopic = async (topic: string): Promise<void> => {
		const meta = this.meta;
		if (meta === undefined) return;
		for (const id of topicCascade(meta, topic)) {
			const record = meta.sessions[id];
			if (record !== undefined) await this.erase(record);
		}
	};

	/**
	 * Start a new application session: tear down the old one, create the folder. The single
	 * creation point — every new-app-session flow goes through here.
	 */
	private readonly beginAppSession = async (root: string): Promise<void> => {
		this.reset();
		this.meta = await createAppSession(root);
	};

	private readonly reset = (): void => {
		for (const session of this.sessions.values()) session.detachLive()?.dispose();
		this.sessions.clear();
		this.bindings.clear();
		for (const dir of this.trackedDirs.values()) dir.close();
		this.trackedDirs.clear();
		this.meta = undefined;
		this.currentViewing = undefined;
		this.pendingAgent = undefined;
		this.pendingRecord = undefined;
	};

	/** The in-memory meta of the active app session. */
	private readonly readMeta = (): AppMeta => {
		if (this.meta === undefined) throw new Error('no application session');
		return this.meta;
	};

	/** Mutate the in-memory meta and persist it fire-and-forget. */
	private readonly writeMeta = (fn: (meta: AppMeta) => void): AppMeta => {
		const meta = this.readMeta();
		fn(meta);
		// A vanished app folder (manual deletion) is not an error here.
		void persistMeta(meta).catch(() => {});
		return meta;
	};

	/**
	 * Create a background SDK session continuing `record` and bind its identity. Built from the
	 * host's module so the session can later be adopted by the interactive runtime (see
	 * ./patch.ts). SDK sessions do not load built-in extensions, so `createMcpExtension` is passed
	 * explicitly — agent definitions that register MCP servers work in background sessions.
	 */
	private async createBackground(record: SessionRecord): Promise<LiveSession> {
		if (this.appFolder === undefined || this.cwd === undefined)
			throw new Error('no application session');
		this.watchSession(record);
		const pi = await hostPi();
		const sessionManager = pi.SessionManager.open(record.recordPath, undefined, this.cwd);
		this.bindings.set(sessionManager.getSessionId(), bindingOf(this.appFolder, record));
		const agentDir = pi.getAgentDir();
		const resourceLoader = new pi.DefaultResourceLoader({
			agentDir,
			cwd: this.cwd,
			extensionFactories: [pi.createMcpExtension()],
			settingsManager: pi.SettingsManager.create(this.cwd, agentDir),
		});
		await resourceLoader.reload();
		const { session } = await pi.createAgentSession({
			cwd: this.cwd,
			resourceLoader,
			sessionManager,
		});
		await session.bindExtensions({});
		return session;
	}

	/** Remove a session: live instance, record + note files, and meta entry. */
	private async erase(record: SessionRecord): Promise<void> {
		this.sessions.get(record.id)?.detachLive()?.dispose();
		this.sessions.delete(record.id);
		await rm(record.recordPath, { force: true });
		await rm(join(this.appFolder ?? dirname(record.recordPath), `${record.id}.md`), {
			force: true,
		});
		this.writeMeta((m) => {
			delete m.sessions[record.id];
		});
	}

	root = {
		activate: (meta: AppMeta): void => {
			this.meta = meta;
		},
		appFolder: (): string | undefined => this.appFolder,
		armPending: (agent: string): void => {
			this.pendingAgent = agent;
			this.pendingRecord = undefined;
		},
		beginAppSession: this.beginAppSession,
		bindByFile: this.bindByFile,
		/** Track a session instance under its harness session id. */
		bindSession: (sessionId: string, session: Session): void => {
			this.sessions.set(sessionId, session);
		},
		bindingOf: (piSessionId: string): SessionBinding | undefined =>
			this.bindings.get(piSessionId),
		captureFirstMessage: this.captureFirstMessage,
		ensureLive: this.ensureLive,
		meta: this.readMeta,
		mutateMeta: this.writeMeta,
		pendingAgent: (): string | undefined => this.pendingAgent,
		provisionPending: this.provisionPending,
		putLive: (id: string, live: LiveSession): void => {
			this.sessions.get(id)?.attachLive(live);
		},
		registerViewing: this.registerViewing,
		reset: this.reset,
		sessionOf: (id: string): Session | undefined => this.sessions.get(id),
		spawn: this.spawn,
		takeLive: (id: string): LiveSession | undefined => this.sessions.get(id)?.detachLive(),
		/** The controller cwd, used to create background sessions. */
		useCwd: (cwd: string): void => {
			this.cwd = cwd;
		},
		viewing: (): string | undefined => this.currentViewing,
	};
}

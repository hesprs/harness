/**
 * Persistence model (pure): the application-session folder + meta.json and
 * session records. No state; all mutation happens through the Sessions
 * module (single writer by construction). Relationships and talkable-agent
 * semantics live in the Controller; handoff in ./patch.ts.
 */
import { existsSync, readdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type SessionRecord = {
	id: string;
	agent: string;
	/** Topic context file path, if this session belongs to a topic. */
	topic?: string;
	/** Session that spawned the first agent in this topic (the topic leader). */
	leaderSessionId?: string;
	/** Spawner, for topic-less lineage. */
	parentSessionId?: string;
	recordPath: string;
	createdAt: string;
	status: 'running' | 'stopped';
};

export type LeaderTalk = {
	at: string;
	from: string;
	message: string;
	relationship: Relationship;
};

export type Relationship = 'leader' | 'colleague' | 'child';

export type AppMeta = {
	appSessionId: string;
	appFolder: string;
	/** First user message that started the first agent (display name in /apps). */
	firstMessage?: string;
	currentViewingSessionId?: string;
	/** Talks received by the human leader, displayed via /talks. */
	leaderTalks?: Array<LeaderTalk>;
	sessions: Record<string, SessionRecord>;
};

/** `~/.pi/agent/sessions/--<cwd>--` root for a given cwd. */
export function appSessionsRoot(cwd: string): string {
	const encoded = cwd.replaceAll(/[/\\]+/gu, '-').replaceAll(/^-+|-+$/gu, '');
	return join(homedir(), '.pi', 'agent', 'sessions', `--${encoded}--`);
}

/** Create a new application-session folder (timestamp-hash) with empty meta.json. */
export async function createAppSession(root: string): Promise<AppMeta> {
	const appSessionId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
	const appFolder = join(root, appSessionId);
	const meta: AppMeta = { appFolder, appSessionId, sessions: {} };
	await persistMeta(meta);
	return meta;
}

/** Atomic meta.json write (fire-and-forget from mutation paths). */
export async function persistMeta(meta: AppMeta): Promise<void> {
	const metaPath = join(meta.appFolder, 'meta.json');
	const tmp = `${metaPath}.${crypto.randomUUID().slice(0, 8)}.tmp`;
	await Bun.write(tmp, JSON.stringify(meta, undefined, '\t'));
	renameSync(tmp, metaPath);
}

/** All application-session folders under root, newest first. */
export async function listAppSessions(root: string): Promise<Array<AppMeta>> {
	if (!existsSync(root)) return [];
	const metas: Array<AppMeta> = [];
	for (const entry of readdirSync(root)) {
		const metaPath = join(root, entry, 'meta.json');
		if (!existsSync(metaPath)) continue;
		metas.push(JSON.parse(await Bun.file(metaPath).text()) as AppMeta);
	}
	metas.sort((a, b) => b.appSessionId.localeCompare(a.appSessionId));
	return metas;
}

/** Register a session in an application session: allocate `<agent>-<hash>` id. */
export function newSessionId(agent: string): string {
	return `${agent}-${crypto.randomUUID().replaceAll('-', '').slice(0, 5)}`;
}

export type RegisterSessionOptions = {
	spawnerId: string;
	sessionId: string;
	agent: string;
	recordPath: string;
	topic?: string;
};

/** Compute relationships for a fresh session and update meta (in place). */
export function registerSession(meta: AppMeta, opts: RegisterSessionOptions): SessionRecord {
	const record: SessionRecord = {
		agent: opts.agent,
		createdAt: new Date().toISOString(),
		id: opts.sessionId,
		recordPath: opts.recordPath,
		status: 'running',
	};
	if (opts.topic === undefined) record.parentSessionId = opts.spawnerId;
	else {
		record.topic = opts.topic;
		const existing = Object.values(meta.sessions).find((s) => s.topic === opts.topic);
		// The spawner of the topic's first agent is the leader.
		record.leaderSessionId = existing?.leaderSessionId ?? opts.spawnerId;
	}
	meta.sessions[opts.sessionId] = record;
	return record;
}

/** The session record whose record file is `path`, if any. */
export function recordByPath(meta: AppMeta, path: string): SessionRecord | undefined {
	return Object.values(meta.sessions).find((s) => s.recordPath === path);
}

/** Session ids removed by deleting topic `topicPath`: members + their descendants. */
export function topicCascade(meta: AppMeta, topicPath: string): Array<string> {
	const removed = new Set<string>();
	for (const record of Object.values(meta.sessions))
		if (record.topic === topicPath) removed.add(record.id);

	let grew = true;
	while (grew) {
		grew = false;
		for (const record of Object.values(meta.sessions)) {
			if (removed.has(record.id)) continue;
			if (record.topic === undefined && removed.has(record.parentSessionId ?? '')) {
				removed.add(record.id);
				grew = true;
			}
		}
	}
	return [...removed];
}

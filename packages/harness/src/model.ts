import type { AgentDefinition } from '@repo/shared/contract';
import { LEADER_ID } from '@repo/shared/contract';
/**
 * Session-world domain model (pure): the application-session folder +
 * meta.json, session records, relationships, topic cascades
 * and talk-message formatting. No state; all mutation happens
 * through the Sessions module (single writer by construction).
 */
import { existsSync, readdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LEADER_AGENT = 'commander';
const LEADER_DESCRIPTION = 'Leader that proposes ideas and coordinates works.';

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
	notePath: string;
	createdAt: string;
	status: 'running' | 'stopped';
};

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

export type LeaderTalk = {
	at: string;
	from: string;
	message: string;
	relationship: Relationship;
};

export type Relationship = 'leader' | 'colleague' | 'child';

export type TalkableSession = {
	id: string;
	agent: string;
	description: string;
	relationship: Relationship;
	note: string;
	recordPath: string | undefined;
};

/**
 * The effective parent of a session: its topic leader when it belongs to a
 * topic, otherwise its spawner.
 */
function parentOf(meta: AppMeta, id: string): string | undefined {
	const record = meta.sessions[id];
	if (!record) return undefined;
	return record.topic ? record.leaderSessionId : record.parentSessionId;
}

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
	await Bun.write(join(appFolder, 'meta.json'), JSON.stringify(meta, undefined, '\t'));
	return meta;
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

/** Atomic read-modify-write access to an app session's meta.json. */
export class MetaStore {
	private readonly metaPath: string;

	constructor(appFolder: string) {
		this.metaPath = join(appFolder, 'meta.json');
	}

	async read(): Promise<AppMeta> {
		return JSON.parse(await Bun.file(this.metaPath).text()) as AppMeta;
	}

	async mutate(fn: (meta: AppMeta) => void): Promise<AppMeta> {
		const meta = await this.read();
		fn(meta);
		const tmp = `${this.metaPath}.${crypto.randomUUID().slice(0, 8)}.tmp`;
		await Bun.write(tmp, JSON.stringify(meta, undefined, '\t'));
		renameSync(tmp, this.metaPath);
		return meta;
	}
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
	notePath: string;
	topic?: string;
};

/** Compute relationships for a fresh session and update meta (in place). */
export function registerSession(meta: AppMeta, opts: RegisterSessionOptions): SessionRecord {
	const record: SessionRecord = {
		agent: opts.agent,
		createdAt: new Date().toISOString(),
		id: opts.sessionId,
		notePath: opts.notePath,
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

/** Role of `to` as seen by `from`: its leader, colleague, or child; null otherwise. */
export function relationship(meta: AppMeta, from: string, to: string): Relationship | undefined {
	if (from === to) return undefined;
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
	return undefined;
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

function readNote(path: string): Promise<string> {
	return Bun.file(path)
		.text()
		.catch(() => '');
}

/** Sessions `selfId` can talk to (its leader, colleagues, children), leader included. */
export async function talkableSessions(
	meta: AppMeta,
	agents: (name: string) => AgentDefinition | undefined,
	selfId: string,
): Promise<Array<TalkableSession>> {
	const out: Array<TalkableSession> = [];
	if (relationship(meta, LEADER_ID, selfId) !== undefined)
		out.push({
			agent: LEADER_AGENT,
			description: LEADER_DESCRIPTION,
			id: LEADER_ID,
			note: '',
			recordPath: undefined,
			relationship: 'leader',
		});

	for (const record of Object.values(meta.sessions)) {
		const rel = relationship(meta, record.id, selfId);
		if (!rel || record.id === selfId) continue;
		out.push({
			agent: record.agent,
			description: agents(record.agent)?.description ?? '',
			id: record.id,
			note: await readNote(record.notePath),
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

export type EncodedTalk = { content: string; customType: 'talk'; display: true };

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

import { LEADER_ID } from '@repo/shared/contract';
import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppMeta, SessionRecord } from '@/model';
import {
	MetaStore,
	createAppSession,
	decodeTalk,
	encodeTalk,
	formatTalkNotice,
	listAppSessions,
	newSessionId,
	recordByPath,
	registerSession,
	relationship,
	talkableSessions,
	topicCascade,
} from '@/model';

function tmpRoot(): string {
	return mkdtempSync(join(tmpdir(), 'harness-model-'));
}

function session(partial: Partial<SessionRecord> & { id: string }): SessionRecord {
	return {
		agent: 'default',
		createdAt: new Date().toISOString(),
		notePath: `/rec/${partial.id}.md`,
		recordPath: `/rec/${partial.id}.jsonl`,
		status: 'running',
		...partial,
	};
}

test('createAppSession creates a folder with an empty meta.json', async () => {
	const root = tmpRoot();
	try {
		const meta = await createAppSession(root);
		expect(meta.appFolder.startsWith(root)).toBe(true);
		expect(meta.sessions).toEqual({});
		const store = new MetaStore(meta.appFolder);
		expect((await store.read()).appSessionId).toBe(meta.appSessionId);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('listAppSessions returns sessions newest first', async () => {
	const root = tmpRoot();
	try {
		const older = await createAppSession(root);
		await Bun.sleep(20);
		const newer = await createAppSession(root);
		const list = await listAppSessions(root);
		expect(list.map((m) => m.appSessionId)).toEqual([newer.appSessionId, older.appSessionId]);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('MetaStore mutate persists and returns the new state', async () => {
	const root = tmpRoot();
	try {
		const meta = await createAppSession(root);
		const store = new MetaStore(meta.appFolder);
		const updated = await store.mutate((m) => {
			m.sessions.x = session({ id: 'x' });
		});
		expect(updated.sessions.x?.agent).toBe('default');
		expect((await new MetaStore(meta.appFolder).read()).sessions.x).toBeDefined();
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

function metaWith(...records: Array<SessionRecord>) {
	const meta = {
		appFolder: '/app',
		appSessionId: 'app',
		sessions: Object.fromEntries(records.map((r) => [r.id, r])),
	};
	return meta;
}

test('newSessionId is agent-prefixed, unique and hash-suffixed', () => {
	const a = newSessionId('test');
	const b = newSessionId('test');
	expect(a).toMatch(/^test-[a-z0-9]{5}$/u);
	expect(a).not.toBe(b);
});

test('registerSession: first agent in a topic makes the spawner the leader', () => {
	const meta: AppMeta = { appFolder: '/app', appSessionId: 'app', sessions: {} };
	registerSession(meta, {
		agent: 'coder',
		notePath: '/app/A.md',
		recordPath: '/app/A.jsonl',
		sessionId: 'A',
		spawnerId: LEADER_ID,
		topic: '/t.md',
	});
	registerSession(meta, {
		agent: 'coder',
		notePath: '/app/B.md',
		recordPath: '/app/B.jsonl',
		sessionId: 'B',
		spawnerId: 'A',
		topic: '/t.md',
	});
	expect(meta.sessions.A?.leaderSessionId).toBe(LEADER_ID);
	// B joins an existing topic: the leader stays the spawner of the topic's first agent
	expect(meta.sessions.B?.leaderSessionId).toBe(LEADER_ID);
});

test("registerSession: topic-less spawn becomes the spawner's child", () => {
	const meta: AppMeta = { appFolder: '/app', appSessionId: 'app', sessions: {} };
	registerSession(meta, {
		agent: 'coder',
		notePath: '/app/C.md',
		recordPath: '/app/C.jsonl',
		sessionId: 'C',
		spawnerId: LEADER_ID,
	});
	expect(meta.sessions.C?.parentSessionId).toBe(LEADER_ID);
});

test('recordByPath finds the session owning a record file', () => {
	const meta = metaWith(session({ id: 'A' }));
	expect(recordByPath(meta, '/rec/A.jsonl')?.id).toBe('A');
	expect(recordByPath(meta, '/rec/B.jsonl')).toBeUndefined();
});

test('topic members see the topic leader as leader; leader sees them as children', () => {
	const meta = metaWith(
		session({ id: 'A', leaderSessionId: LEADER_ID, topic: '/t.md' }),
		session({ id: 'B', leaderSessionId: LEADER_ID, topic: '/t.md' }),
	);
	expect(relationship(meta, 'A', LEADER_ID)).toBe('leader');
	expect(relationship(meta, LEADER_ID, 'A')).toBe('child');
	expect(relationship(meta, 'A', 'B')).toBe('colleague');
});

test('topic-less children: spawner is leader, siblings are colleagues', () => {
	const meta = metaWith(
		session({ id: 'C', parentSessionId: LEADER_ID }),
		session({ id: 'D', parentSessionId: LEADER_ID }),
	);
	expect(relationship(meta, 'C', LEADER_ID)).toBe('leader');
	expect(relationship(meta, LEADER_ID, 'C')).toBe('child');
	expect(relationship(meta, 'C', 'D')).toBe('colleague');
});

test('unrelated sessions have no relationship', () => {
	const meta = metaWith(
		session({ id: 'A', leaderSessionId: LEADER_ID, topic: '/t.md' }),
		session({ id: 'D', parentSessionId: LEADER_ID }),
	);
	expect(relationship(meta, 'A', 'D')).toBeUndefined();
});

test('topicCascade covers topic members and their descendants', () => {
	const meta = metaWith(
		session({ id: 'A', leaderSessionId: LEADER_ID, topic: '/t.md' }),
		session({ id: 'B', leaderSessionId: 'A', topic: '/t.md' }),
		session({ id: 'E', parentSessionId: 'B' }),
		session({ id: 'Z', parentSessionId: LEADER_ID }),
	);
	const casc = topicCascade(meta, '/t.md');
	expect(casc).toContain('A');
	expect(casc).toContain('B');
	expect(casc).toContain('E');
	expect(casc).not.toContain('Z');
});

test('talkableSessions lists leader, colleagues, children with relationship and metadata', async () => {
	const root = tmpRoot();
	try {
		const meta = await createAppSession(root);
		const store = new MetaStore(meta.appFolder);
		await store.mutate((m) => {
			m.sessions.A = session({
				agent: 'coder',
				id: 'A',
				leaderSessionId: LEADER_ID,
				notePath: join(meta.appFolder, 'A.md'),
				topic: '/t.md',
			});
			m.sessions.B = session({
				agent: 'coder',
				id: 'B',
				leaderSessionId: LEADER_ID,
				notePath: join(meta.appFolder, 'B.md'),
				topic: '/t.md',
			});
		});
		await Bun.write(join(meta.appFolder, 'A.md'), 'note of A');
		await Bun.write(join(meta.appFolder, 'B.md'), 'note of B');
		const lookup = (name: string) =>
			name === 'coder' ? ({ description: 'writes code', name } as never) : undefined;
		const fromA = await talkableSessions(await store.read(), lookup, 'A');
		const ids = fromA.map((s) => s.id);
		expect(ids).toContain(LEADER_ID);
		expect(ids).toContain('B');
		expect(ids).not.toContain('A');
		const leader = fromA.find((s) => s.id === LEADER_ID);
		expect(leader?.relationship).toBe('leader');
		expect(leader?.recordPath).toBeUndefined();
		const b = fromA.find((s) => s.id === 'B');
		expect(b?.relationship).toBe('colleague');
		expect(b?.note).toBe('note of B');
		expect(b?.description).toBe('writes code');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('formatTalkNotice renders sender, relationship and message', () => {
	expect(formatTalkNotice('A', 'colleague', 'hello')).toBe('[talk from `A` (colleague)] hello');
});

test('encodeTalk and decodeTalk round-trip a talk message', () => {
	const encoded = encodeTalk('A', 'child', 'hi');
	expect(encoded.customType).toBe('talk');
	expect(encoded.display).toBe(true);
	expect(decodeTalk(encoded.content)).toEqual({
		from: 'A',
		message: 'hi',
		relationship: 'child',
	});
});

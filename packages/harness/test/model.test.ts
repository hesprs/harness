import {
	createAppSession,
	listAppSessions,
	newSessionId,
	recordByPath,
	registerSession,
	topicCascade,
} from '@/model';
import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppMeta, SessionRecord } from '@/model';

function tmpRoot(): string {
	return mkdtempSync(join(tmpdir(), 'harness-model-'));
}

function session(partial: Partial<SessionRecord> & { id: string }): SessionRecord {
	return {
		agent: 'default',
		createdAt: new Date().toISOString(),
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
		const disk = JSON.parse(
			await Bun.file(join(meta.appFolder, 'meta.json')).text(),
		) as AppMeta;
		expect(disk.appSessionId).toBe(meta.appSessionId);
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
		recordPath: '/app/A.jsonl',
		sessionId: 'A',
		spawnerId: 'commander-00001',
		topic: '/t.md',
	});
	registerSession(meta, {
		agent: 'coder',
		recordPath: '/app/B.jsonl',
		sessionId: 'B',
		spawnerId: 'A',
		topic: '/t.md',
	});
	expect(meta.sessions.A?.leaderSessionId).toBe('commander-00001');
	// B joins an existing topic: the leader stays the spawner of the topic's first agent
	expect(meta.sessions.B?.leaderSessionId).toBe('commander-00001');
});

test("registerSession: topic-less spawn becomes the spawner's child", () => {
	const meta: AppMeta = { appFolder: '/app', appSessionId: 'app', sessions: {} };
	registerSession(meta, {
		agent: 'coder',
		recordPath: '/app/C.jsonl',
		sessionId: 'C',
		spawnerId: 'commander-00001',
	});
	expect(meta.sessions.C?.parentSessionId).toBe('commander-00001');
});

test('recordByPath finds the session owning a record file', () => {
	const meta = metaWith(session({ id: 'A' }));
	expect(recordByPath(meta, '/rec/A.jsonl')?.id).toBe('A');
	expect(recordByPath(meta, '/rec/B.jsonl')).toBeUndefined();
});

test('topicCascade covers topic members and their descendants', () => {
	const meta = metaWith(
		session({ id: 'A', leaderSessionId: 'commander-00001', topic: '/t.md' }),
		session({ id: 'B', leaderSessionId: 'A', topic: '/t.md' }),
		session({ id: 'E', parentSessionId: 'B' }),
		session({ id: 'Z', parentSessionId: 'commander-00001' }),
	);
	const casc = topicCascade(meta, '/t.md');
	expect(casc).toContain('A');
	expect(casc).toContain('B');
	expect(casc).toContain('E');
	expect(casc).not.toContain('Z');
});

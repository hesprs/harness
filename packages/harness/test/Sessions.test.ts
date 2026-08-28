import { LEADER_ID } from '@repo/shared/contract';
import { test, expect } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionRecord } from '@/model';
import type { LiveSession } from '@/Sessions';
import { MetaStore, createAppSession, registerSession } from '@/model';
import Sessions from '@/Sessions';

function tmpRoot(): string {
	return mkdtempSync(join(tmpdir(), 'harness-sessions-'));
}

function stubSession(actions: Array<string>, streaming = false): LiveSession {
	return {
		dispose: () => {
			actions.push('dispose');
		},
		isStreaming: streaming,
		prompt: (text: string) => {
			actions.push(`prompt:${text}`);
			return Promise.resolve();
		},
		sessionManager: { getSessionFile: () => {} },
		steer: (text: string) => {
			actions.push(`steer:${text}`);
			return Promise.resolve();
		},
	};
}

test('registerViewing creates the note, record, viewing and binding', async () => {
	const root = tmpRoot();
	try {
		const sessions = new Sessions({ registerSection: () => {} });
		sessions.root.armPending('coder');
		await sessions.root.beginAppSession(root);
		const binding = await sessions.root.registerViewing({
			agent: 'coder',
			piSessionId: 'pi-1',
		});
		expect(binding.agent).toBe('coder');
		expect(binding.sessionId).toMatch(/^coder-[a-z0-9]{5}$/u);
		expect(existsSync(join(binding.appFolder, `${binding.sessionId}.md`))).toBe(true);
		const meta = await new MetaStore(binding.appFolder).read();
		expect(meta.sessions[binding.sessionId]?.recordPath).toBe(
			join(binding.appFolder, `${binding.sessionId}.jsonl`),
		);
		expect(meta.currentViewingSessionId).toBe(binding.sessionId);
		expect(sessions.root.viewing()).toBe(binding.sessionId);
		expect(sessions.root.bindingOf('pi-1')?.sessionId).toBe(binding.sessionId);
		expect(sessions.root.pendingAgent()).toBeUndefined();
		expect(sessions.root.appFolder()).toBe(binding.appFolder);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('registerViewing records the topic on the session', async () => {
	const root = tmpRoot();
	try {
		const sessions = new Sessions({ registerSection: () => {} });
		await sessions.root.beginAppSession(root);
		const binding = await sessions.root.registerViewing({
			agent: 'coder',
			piSessionId: 'pi-1',
			topic: join(root, 'topic.md'),
		});
		expect(binding.topic).toBe(join(root, 'topic.md'));
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('bindByFile binds a record from any app session under the root', async () => {
	const root = tmpRoot();
	try {
		const first = new Sessions({ registerSection: () => {} });
		await first.root.beginAppSession(root);
		const created = await first.root.registerViewing({
			agent: 'coder',
			piSessionId: 'pi-1',
		});
		const later = new Sessions({ registerSection: () => {} });
		const found = await later.root.bindByFile('pi-2', created.recordPath, root);
		expect(found?.sessionId).toBe(created.sessionId);
		expect(later.root.viewing()).toBe(created.sessionId);
		expect(later.root.appFolder()).toBe(created.appFolder);
		expect(later.root.bindingOf('pi-2')?.sessionId).toBe(created.sessionId);
		expect(
			await later.root.bindByFile('pi-3', join(root, 'unknown.jsonl'), root),
		).toBeUndefined();
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('captureFirstMessage records the first message once', async () => {
	const root = tmpRoot();
	try {
		const sessions = new Sessions({ registerSection: () => {} });
		await sessions.root.beginAppSession(root);
		const binding = await sessions.root.registerViewing({
			agent: 'coder',
			piSessionId: 'pi-1',
		});
		await sessions.root.captureFirstMessage('first line\nmore');
		await sessions.root.captureFirstMessage('second message');
		const meta = await new MetaStore(binding.appFolder).read();
		expect(meta.firstMessage).toBe('first line');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('liveFor returns a registered background session and rejects unknown ids', async () => {
	const root = tmpRoot();
	try {
		const app = await createAppSession(root);
		const sessions = new Sessions({ registerSection: () => {} });
		sessions.root.activate(app.appFolder);
		await sessions.root.mutateMeta((m) => {
			registerSession(m, {
				agent: 'coder',
				notePath: join(app.appFolder, 'A.md'),
				recordPath: join(app.appFolder, 'A.jsonl'),
				sessionId: 'A',
				spawnerId: LEADER_ID,
			});
		});
		const stub = stubSession([]);
		sessions.root.putBackground('A', stub);
		expect(await sessions.root.liveFor('A')).toBe(stub);
		// oxlint-disable-next-line typescript/await-thenable
		await expect(sessions.root.liveFor('ghost')).rejects.toThrow('unknown session');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

type AddOpts = { streaming?: boolean; parent?: string; topic?: string; leader?: string };

async function setup() {
	const root = tmpRoot();
	const app = await createAppSession(root);
	const sessions = new Sessions({ registerSection: () => {} });
	sessions.root.activate(app.appFolder);
	const store = new MetaStore(app.appFolder);
	const actions: Array<string> = [];
	async function addSession(id: string, opts?: AddOpts): Promise<SessionRecord> {
		let record: SessionRecord | undefined;
		await store.mutate((meta) => {
			record = registerSession(meta, {
				agent: 'coder',
				notePath: join(app.appFolder, `${id}.md`),
				recordPath: join(app.appFolder, `${id}.jsonl`),
				sessionId: id,
				spawnerId: opts?.parent ?? LEADER_ID,
				...(opts?.topic === undefined ? {} : { topic: opts.topic }),
			});
			if (opts?.leader !== undefined) {
				const r = meta.sessions[id];
				if (r !== undefined) r.leaderSessionId = opts.leader;
			}
		});
		if (opts?.streaming === true) sessions.root.putBackground(id, stubSession(actions, true));
		return record as SessionRecord;
	}
	return { actions, addSession, appFolder: app.appFolder, root, sessions };
}

/** Wait (bounded) for asynchronous watcher effects. */
async function until(assert: () => boolean | Promise<boolean>): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (await assert()) return;
		await new Promise((settle) => {
			setTimeout(settle, 10);
		});
	}
	expect(await assert()).toBe(true);
}

test('deleting a record file aborts the session', async () => {
	const root = tmpRoot();
	const actions: Array<string> = [];
	try {
		const sessions = new Sessions({ registerSection: () => {} });
		await sessions.root.beginAppSession(root);
		const binding = await sessions.root.registerViewing({
			agent: 'coder',
			piSessionId: 'pi-1',
		});
		sessions.root.putBackground(binding.sessionId, stubSession(actions));
		await Bun.write(binding.recordPath, 'footage');
		await unlink(binding.recordPath);
		const store = new MetaStore(binding.appFolder);
		await until(async () => (await store.read()).sessions[binding.sessionId] === undefined);
		expect(actions).toEqual(['dispose']);
		expect(existsSync(join(binding.appFolder, `${binding.sessionId}.md`))).toBe(false);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('deleting a topic file aborts every session in the topic', async () => {
	const root = tmpRoot();
	try {
		const sessions = new Sessions({ registerSection: () => {} });
		await sessions.root.beginAppSession(root);
		const topic = join(sessions.root.appFolder() ?? '', 'topic.md');
		await Bun.write(topic, '# topic');
		const first = await sessions.root.registerViewing({
			agent: 'coder',
			piSessionId: 'pi-1',
			topic,
		});
		const second = await sessions.root.registerViewing({
			agent: 'coder',
			piSessionId: 'pi-2',
			topic,
		});
		await unlink(topic);
		const store = new MetaStore(first.appFolder);
		await until(
			async () =>
				(await store.read()).sessions[first.sessionId] === undefined &&
				(await store.read()).sessions[second.sessionId] === undefined,
		);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('reset disposes background sessions and clears all state', async () => {
	const { addSession, appFolder, root, sessions } = await setup();
	try {
		await addSession('A', { streaming: true });
		await sessions.root.registerViewing({
			agent: 'coder',
			piSessionId: 'pi-1',
		});
		sessions.root.reset();
		expect(sessions.root.appFolder()).toBeUndefined();
		expect(sessions.root.viewing()).toBeUndefined();
		expect(sessions.root.bindingOf('pi-1')).toBeUndefined();
		expect(sessions.root.backgroundOf('A')).toBeUndefined();
		expect((await new MetaStore(appFolder).read()).sessions.A).toBeDefined();
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('provisionPending locates the record inside the app folder; registerViewing consumes it', async () => {
	const root = tmpRoot();
	try {
		const sessions = new Sessions({ registerSection: () => {} });
		await sessions.root.beginAppSession(root);
		const record = sessions.root.provisionPending('writer');
		expect(record.recordPath).toBe(
			join(sessions.root.appFolder() ?? '', `${record.sessionId}.jsonl`),
		);
		// Re-provisioning is stable (same pending record).
		expect(sessions.root.provisionPending('writer')).toEqual(record);
		// Arming clears the provision: the next one mints a fresh record.
		sessions.root.armPending('coder');
		expect(sessions.root.provisionPending('coder').sessionId).not.toBe(record.sessionId);
		const binding = await sessions.root.registerViewing({
			agent: 'coder',
			piSessionId: 'pi-1',
		});
		expect(binding.sessionId).not.toBe(record.sessionId);
		expect(existsSync(binding.recordPath)).toBe(false); // Registration does not create the file
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

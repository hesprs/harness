import { LEADER_ID } from '@repo/shared/contract';
import { test, expect } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppMeta, SessionRecord } from '@/model';
import type Session from '@/Session';
import type { LiveSession } from '@/Sessions';
import { createAppSession, registerSession } from '@/model';
import Sessions from '@/Sessions';

function tmpRoot(): string {
	return mkdtempSync(join(tmpdir(), 'harness-sessions-'));
}

/** The meta.json as written on disk (fire-and-forget persists land late). */
async function diskMeta(folder: string): Promise<AppMeta> {
	return JSON.parse(await Bun.file(join(folder, 'meta.json')).text()) as AppMeta;
}

/** A session stand-in tracking its live handle. */
function fakeSession() {
	const session = {
		attachLive: (l: LiveSession) => {
			session.live = l;
		},
		deliver: () => Promise.resolve(),
		detachLive: () => {
			const l = session.live;
			session.live = undefined;
			return l;
		},
		info: (base: string) => base,
		live: undefined as LiveSession | undefined,
	};
	return { session: session as unknown as Session };
}

function stubLive(actions: Array<string>): LiveSession {
	return {
		dispose: () => {
			actions.push('dispose');
		},
		isStreaming: false,
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

test('registerViewing creates the record, viewing and binding', async () => {
	const root = tmpRoot();
	try {
		const sessions = new Sessions();
		sessions.root.armPending('coder');
		await sessions.root.beginAppSession(root);
		const binding = sessions.root.registerViewing({
			agent: 'coder',
			piSessionId: 'pi-1',
		});
		expect(binding.agent).toBe('coder');
		expect(binding.sessionId).toMatch(/^coder-[a-z0-9]{5}$/u);
		const meta = sessions.root.meta();
		expect(meta.sessions[binding.sessionId]?.recordPath).toBe(
			join(binding.appFolder, `${binding.sessionId}.jsonl`),
		);
		expect(meta.currentViewingSessionId).toBe(binding.sessionId);
		expect(sessions.root.viewing()).toBe(binding.sessionId);
		expect(sessions.root.bindingOf('pi-1')?.sessionId).toBe(binding.sessionId);
		expect(sessions.root.pendingAgent()).toBeUndefined();
		expect(sessions.root.appFolder()).toBe(binding.appFolder);
		// The fire-and-forget persist lands on disk eventually.
		await until(
			async () =>
				(await diskMeta(binding.appFolder)).sessions[binding.sessionId] !== undefined,
		);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('registerViewing records the topic on the session', async () => {
	const root = tmpRoot();
	try {
		const sessions = new Sessions();
		await sessions.root.beginAppSession(root);
		const binding = sessions.root.registerViewing({
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
		const first = new Sessions();
		await first.root.beginAppSession(root);
		const created = first.root.registerViewing({
			agent: 'coder',
			piSessionId: 'pi-1',
		});
		// The fire-and-forget persist must land before another instance can
		// Discover the record from disk.
		await until(
			async () =>
				(await diskMeta(created.appFolder)).sessions[created.sessionId] !== undefined,
		);
		const later = new Sessions();
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
		const sessions = new Sessions();
		await sessions.root.beginAppSession(root);
		sessions.root.registerViewing({
			agent: 'coder',
			piSessionId: 'pi-1',
		});
		sessions.root.captureFirstMessage('first line\nmore');
		sessions.root.captureFirstMessage('second message');
		expect(sessions.root.meta().firstMessage).toBe('first line');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('putLive/takeLive attach a live handle to the bound session', async () => {
	const root = tmpRoot();
	try {
		const app = await createAppSession(root);
		const sessions = new Sessions();
		sessions.root.activate(app);
		sessions.root.mutateMeta((m) => {
			registerSession(m, {
				agent: 'coder',
				recordPath: join(app.appFolder, 'A.jsonl'),
				sessionId: 'A',
				spawnerId: LEADER_ID,
			});
		});
		const { session } = fakeSession();
		sessions.root.bindSession('A', session);
		sessions.root.putLive('A', stubLive([]));
		const got = await sessions.root.ensureLive('A');
		expect(got).toBe(session);
		expect(sessions.root.takeLive('A')).toBeDefined();
		expect(sessions.root.takeLive('A')).toBeUndefined();
		// oxlint-disable-next-line typescript/await-thenable
		await expect(sessions.root.ensureLive('ghost')).rejects.toThrow('unknown session');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

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

test('deleting a record file aborts the session and removes the note file', async () => {
	const root = tmpRoot();
	const actions: Array<string> = [];
	try {
		const sessions = new Sessions();
		await sessions.root.beginAppSession(root);
		const binding = sessions.root.registerViewing({
			agent: 'coder',
			piSessionId: 'pi-1',
		});
		const { session } = fakeSession();
		sessions.root.bindSession(binding.sessionId, session);
		sessions.root.putLive(binding.sessionId, stubLive(actions));
		await Bun.write(binding.recordPath, 'footage');
		// The note file, by convention inside the app session folder.
		await Bun.write(join(binding.appFolder, `${binding.sessionId}.md`), 'note');
		await unlink(binding.recordPath);
		await until(
			async () =>
				(await diskMeta(binding.appFolder)).sessions[binding.sessionId] === undefined,
		);
		expect(actions).toEqual(['dispose']);
		expect(existsSync(join(binding.appFolder, `${binding.sessionId}.md`))).toBe(false);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('deleting a topic file aborts every session in the topic', async () => {
	const root = tmpRoot();
	try {
		const sessions = new Sessions();
		await sessions.root.beginAppSession(root);
		const topic = join(sessions.root.appFolder() ?? '', 'topic.md');
		await Bun.write(topic, '# topic');
		const first = sessions.root.registerViewing({
			agent: 'coder',
			piSessionId: 'pi-1',
			topic,
		});
		const second = sessions.root.registerViewing({
			agent: 'coder',
			piSessionId: 'pi-2',
			topic,
		});
		await unlink(topic);
		await until(
			async () =>
				(await diskMeta(first.appFolder)).sessions[first.sessionId] === undefined &&
				(await diskMeta(first.appFolder)).sessions[second.sessionId] === undefined,
		);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('reset disposes live sessions and clears all state', async () => {
	const root = tmpRoot();
	const actions: Array<string> = [];
	try {
		const app = await createAppSession(root);
		const sessions = new Sessions();
		sessions.root.activate(app);
		sessions.root.mutateMeta((m) => {
			registerSession(m, {
				agent: 'coder',
				recordPath: join(app.appFolder, 'A.jsonl'),
				sessionId: 'A',
				spawnerId: LEADER_ID,
			});
		});
		const { session } = fakeSession();
		sessions.root.bindSession('A', session);
		sessions.root.putLive('A', stubLive(actions));
		sessions.root.registerViewing({
			agent: 'coder',
			piSessionId: 'pi-1',
		});
		sessions.root.reset();
		expect(sessions.root.appFolder()).toBeUndefined();
		expect(sessions.root.viewing()).toBeUndefined();
		expect(sessions.root.bindingOf('pi-1')).toBeUndefined();
		expect(sessions.root.sessionOf('A')).toBeUndefined();
		expect(actions).toEqual(['dispose']);
		// The persisted disk copy survives the in-memory reset.
		await until(async () => (await diskMeta(app.appFolder)).sessions.A !== undefined);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('provisionPending locates the record inside the app folder; registerViewing consumes it', async () => {
	const root = tmpRoot();
	try {
		const sessions = new Sessions();
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
		const binding = sessions.root.registerViewing({
			agent: 'coder',
			piSessionId: 'pi-1',
		});
		expect(binding.sessionId).not.toBe(record.sessionId);
		expect(existsSync(binding.recordPath)).toBe(false); // Registration does not create the file
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

void (undefined as SessionRecord | undefined);

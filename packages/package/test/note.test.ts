import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { KernelContract } from '@repo/shared/contract';
import { SYSTEM_REMINDER_CHANNEL, TALKABLE_INFO_CHANNEL } from '@repo/shared/contract';
import { test, expect } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import personalNote from '@/note';

/** Capturing pi stub: handlers and event listeners are invocable. */
function makePi(tools: Array<string> = ['write']) {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	const pi = {
		events: {
			emit: () => {},
			on: (channel: string, listener: (data: unknown) => void) => {
				const list = listeners.get(channel) ?? [];
				list.push(listener);
				listeners.set(channel, list);
			},
		},
		getActiveTools: () => tools,
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};
	return {
		fire: (event: string, ev: unknown, ctx: unknown) =>
			Promise.all((handlers.get(event) ?? []).map((h) => h(ev, ctx))),
		listeners,
		pi: pi as unknown as ExtensionAPI,
	};
}

type Fixture = {
	appFolder: string;
	fire: ReturnType<typeof makePi>['fire'];
	listeners: Map<string, Array<(data: unknown) => void>>;
	root: string;
};

async function setup(tools?: Array<string>): Promise<Fixture> {
	const root = mkdtempSync(join(tmpdir(), 'harness-note-'));
	const appFolder = join(root, 'app-1');
	await Bun.write(join(appFolder, 'meta.json'), '{"sessions":{}}');
	const { fire, listeners, pi } = makePi(tools);
	const sessionFile = join(appFolder, 'worker-00001.jsonl');
	await Bun.write(sessionFile, '');
	(globalThis as { harnessKernel?: KernelContract }).harnessKernel = {
		appFolder: () => appFolder,
		bindingOf: (piSessionId: string) =>
			piSessionId === 'pi-1' ? { appFolder, sessionId: 'worker-00001' } : undefined,
		defineAgent: () => '',
		defineBaseAgent: () => {},
		deliverTalk: () => Promise.resolve(),
		get: () => {},
		spawn: () => Promise.resolve({ recordPath: '', sessionId: '' }),
	};
	await personalNote(pi);
	const ctx = {
		getSystemPrompt: () => 'base prompt',
		sessionManager: { getSessionId: () => 'pi-1' },
	};
	await fire('before_agent_start', { type: 'before_agent_start' }, ctx);
	return { appFolder, fire, listeners, root };
}

test('the note section lands in the system prompt and the note file is created', async () => {
	const { fire, root } = await setup();
	try {
		const result = (
			await fire(
				'before_agent_start',
				{},
				{
					getSystemPrompt: () => 'base prompt',
					sessionManager: { getSessionId: () => 'pi-1' },
				},
			)
		)[0] as { systemPrompt: string };
		expect(result.systemPrompt.startsWith('base prompt')).toBe(true);
		expect(result.systemPrompt).toContain('<personal-note>');
		expect(result.systemPrompt).toContain(join(root, 'app-1', 'worker-00001.md'));
		expect(result.systemPrompt).toContain('You can edit this note');
		expect(existsSync(join(root, 'app-1', 'worker-00001.md'))).toBe(true);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('without note-editing tools the section omits the editing instruction', async () => {
	const { fire, root } = await setup([]);
	try {
		const result = (
			await fire(
				'before_agent_start',
				{},
				{
					getSystemPrompt: () => '',
					sessionManager: { getSessionId: () => 'pi-1' },
				},
			)
		)[0] as { systemPrompt: string };
		expect(result.systemPrompt).toContain('<personal-note>');
		expect(result.systemPrompt).not.toContain('You can edit this note');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('the context handler only refreshes the cache, injecting no messages', async () => {
	const { appFolder, fire, root } = await setup();
	try {
		await Bun.write(join(appFolder, 'worker-00001.md'), 'my todo');
		const results = await fire(
			'context',
			{ messages: [] },
			{
				sessionManager: { getSessionId: () => 'pi-1' },
			},
		);
		expect(results).toEqual([{}]);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('the system-reminder listener appends the cached note of the event session', async () => {
	const { appFolder, fire, listeners, root } = await setup();
	try {
		await Bun.write(join(appFolder, 'worker-00001.md'), 'my todo');
		// A turn refreshes the cache before the event can be answered.
		await fire(
			'context',
			{ messages: [] },
			{
				sessionManager: { getSessionId: () => 'pi-1' },
			},
		);
		const payload = { text: '' };
		for (const listener of listeners.get(SYSTEM_REMINDER_CHANNEL) ?? []) listener(payload);
		expect(payload.text).toBe('my todo');
		// An empty note leaves the payload untouched.
		await Bun.write(join(appFolder, 'worker-00001.md'), '');
		await fire(
			'context',
			{ messages: [] },
			{
				sessionManager: { getSessionId: () => 'pi-1' },
			},
		);
		const empty = { text: '' };
		for (const listener of listeners.get(SYSTEM_REMINDER_CHANNEL) ?? []) listener(empty);
		expect(empty.text).toBe('');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('the talkable-info listener attaches the cached note of the event session', async () => {
	const { appFolder, fire, listeners, root } = await setup();
	const bare = await setup(); // Note file exists but is empty
	try {
		await Bun.write(join(appFolder, 'worker-00001.md'), 'working on x');
		// A turn refreshes the cache before the event can be answered.
		await fire(
			'context',
			{ messages: [] },
			{
				sessionManager: { getSessionId: () => 'pi-1' },
			},
		);
		const payload = { text: 'base description' };
		for (const listener of listeners.get(TALKABLE_INFO_CHANNEL) ?? []) listener(payload);
		expect(payload.text).toBe(`base description\n\nworking on x`);
		// An empty note leaves the payload untouched.
		const other = { text: 'base description' };
		for (const listener of bare.listeners.get(TALKABLE_INFO_CHANNEL) ?? []) listener(other);
		expect(other.text).toBe('base description');
	} finally {
		rmSync(root, { force: true, recursive: true });
		rmSync(bare.root, { force: true, recursive: true });
	}
});

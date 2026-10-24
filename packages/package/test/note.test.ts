import personalNote from '@/note';
import { TALKABLE_INFO_CHANNEL } from '@repo/shared/contract';
import { test, expect } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { KernelContract } from '@repo/shared/contract';

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
	event: ReturnType<typeof makeEvent>;
	fire: ReturnType<typeof makePi>['fire'];
	listeners: Map<string, Array<(data: unknown) => void>>;
	root: string;
};

function makeEvent() {
	return { systemPromptOptions: { sections: {} as Record<string, string> } };
}

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
	const event = makeEvent();
	await fire('before_agent_start', event, ctx);
	return { appFolder, event, fire, listeners, root };
}

test('the note section lands in systemPromptOptions.sections and the note file is created', async () => {
	const { event, root } = await setup();
	try {
		const section = event.systemPromptOptions.sections['personal-note'];
		expect(section).toContain(join(root, 'app-1', 'worker-00001.md'));
		expect(section).toContain('You can edit this note');
		expect(existsSync(join(root, 'app-1', 'worker-00001.md'))).toBe(true);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('without note-editing tools the section omits the editing instruction', async () => {
	const { event, root } = await setup([]);
	try {
		const section = event.systemPromptOptions.sections['personal-note'];
		expect(section).toBeDefined();
		expect(section).not.toContain('You can edit this note');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('the talkable-info listener attaches the cached note of the event session', async () => {
	const { appFolder, fire, listeners, root } = await setup();
	const bare = await setup(); // Note file exists but is empty
	try {
		await Bun.write(join(appFolder, 'worker-00001.md'), 'working on x');
		// Refresh the cache via before_agent_start before the event can be answered.
		await fire('before_agent_start', makeEvent(), {
			getSystemPrompt: () => '',
			sessionManager: { getSessionId: () => 'pi-1' },
		});
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

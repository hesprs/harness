import type { Kernel } from '@';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { LEADER_ID, SYSTEM_REMINDER_CHANNEL, TALKABLE_INFO_CHANNEL } from '@repo/shared/contract';
import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LiveSession } from '@/Sessions';
import Session from '@/Session';

/** Capturing ExtensionAPI stub: registered handlers and tools are invocable. */
function makePi() {
	const calls: Array<{ kind: string; value: unknown }> = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const tools = new Map<string, { execute: (id: string, params: unknown) => Promise<unknown> }>();
	const eventListeners = new Map<string, Array<(data: unknown) => void>>();
	const pi = {
		events: {
			emit: (channel: string, data: unknown) => {
				calls.push({ kind: 'event', value: { channel, data } });
				for (const listener of eventListeners.get(channel) ?? []) listener(data);
			},
			on: (channel: string, listener: (data: unknown) => void) => {
				const list = eventListeners.get(channel) ?? [];
				list.push(listener);
				eventListeners.set(channel, list);
			},
		},
		getActiveTools: () => ['talk'],
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand: () => {},
		registerEntryRenderer: () => {},
		registerMessageRenderer: () => {},
		registerTool: (tool: {
			name: string;
			execute: (id: string, params: unknown) => Promise<unknown>;
		}) => {
			tools.set(tool.name, tool);
		},
		sendMessage: (message: unknown, options: unknown) => {
			calls.push({ kind: 'sendMessage', value: { message, options } });
			return Promise.resolve();
		},
		setActiveTools: (names: Array<string>) => {
			calls.push({ kind: 'setActiveTools', value: names });
		},
		setModel: (model: unknown) => {
			calls.push({ kind: 'setModel', value: model });
			return Promise.resolve(true);
		},
		setThinkingLevel: (level: unknown) => {
			calls.push({ kind: 'setThinkingLevel', value: level });
		},
	};
	return {
		calls,
		fire: (event: string, ev: unknown, ctx: unknown) =>
			Promise.all((handlers.get(event) ?? []).map((h) => h(ev, ctx))),
		pi: pi as unknown as ExtensionAPI,
		tools,
	};
}

/** Kernel stub: overridable canned methods. */
function makeKernel(overrides: Record<string, unknown> = {}): Kernel {
	const base: Record<string, unknown> = {
		appFolder: () => '/app/1',
		armPending: (agent: string) => {
			base.pendingAgentValue = agent;
		},
		attachSession: () => {},
		beginAppSession: () => Promise.resolve(),
		bindByFile: () => Promise.resolve(),
		bindSession: () => {},
		bindingOf: () => {},
		captureFirstMessage: () => {},
		defaultAgent: () => Promise.resolve('worker'),
		deliverTalk: () => Promise.resolve(),
		formatLeaderTalk: (_id: string, text: string) => `[leader] ${text}`,
		get: () => {},
		loadConfigs: () => Promise.resolve(),
		names: () => ['worker'],
		pendingAgent: () => base.pendingAgentValue,
		pendingAgentValue: undefined,
		provisionPending: () => ({
			recordPath: '/app/1/worker-abcde.jsonl',
			sessionId: 'worker-abcde',
		}),
		registerSurface: () => {},
		registerViewing: () => ({
			agent: 'worker',
			appFolder: '/app/1',
			recordPath: '/app/1/worker-abcde.jsonl',
			sessionId: 'worker-abcde',
		}),
		talkableFor: () => [],
		useCwd: () => {},
		...overrides,
	};
	return base as unknown as Kernel;
}

function makeCtx(overrides: Record<string, unknown> = {}) {
	const setFiles: Array<string> = [];
	const statuses: Array<[string, string]> = [];
	const ctx = {
		cwd: '/work',
		getSystemPrompt: () => 'base <available_skills>skill x</available_skills>',
		hasUI: true,
		isProjectTrusted: () => true,
		modelRegistry: { find: (_provider: string, id: string) => ({ id }) },
		sessionManager: {
			getSessionFile: () => '/default/sessions/pi-1.jsonl',
			getSessionId: () => 'pi-1',
			setSessionFile: (file: string) => {
				setFiles.push(file);
			},
		},
		ui: { setStatus: (key: string, text: string) => statuses.push([key, text]) },
		...overrides,
	} as unknown as ExtensionContext;
	return { ctx, setFiles, statuses };
}

function makeSession(kernelOverrides: Record<string, unknown> = {}) {
	const made = makePi();
	const kernel = makeKernel(kernelOverrides);
	const session = new Session(made.pi, kernel);
	return { ...made, kernel, session };
}

/** Fire session_start then the first user message: the session registers. */
async function startedSession(kernelOverrides: Record<string, unknown> = {}) {
	const made = makeSession(kernelOverrides);
	const { ctx } = makeCtx();
	await made.fire('session_start', { type: 'session_start' }, ctx);
	await made.fire('input', { source: 'interactive', text: 'go' }, ctx);
	return { ...made, ctx };
}

test('session_start on a fresh interactive session arms the default agent and relocates the record', async () => {
	const made = makeSession();
	const { ctx, setFiles, statuses } = makeCtx();
	await made.fire('session_start', { type: 'session_start' }, ctx);
	expect(made.session.agent).toBe('worker');
	expect(setFiles).toEqual(['/app/1/worker-abcde.jsonl']);
	expect(made.session.sessionId).toBeUndefined(); // Registers on the first user message
	expect(statuses.at(-1)).toEqual(['harness', 'new worker']);
});

test('session_start applies the agent definition: talk-only tools, extensions, model, thinking', async () => {
	const applied: Array<string> = [];
	const made = makeSession({
		get: () => ({
			description: 'd',
			extensions: [
				(pi: ExtensionAPI) => {
					void pi;
					applied.push('extension');
				},
			],
			model: 'zai/glm-test',
			prompts: ['be fast'],
			thinking: 'high',
		}),
	});
	const { ctx } = makeCtx();
	await made.fire('session_start', { type: 'session_start' }, ctx);
	expect(applied).toEqual(['extension']);
	expect(made.calls).toContainEqual({ kind: 'setActiveTools', value: ['talk'] });
	expect(made.calls).toContainEqual({ kind: 'setModel', value: { id: 'glm-test' } });
	expect(made.calls).toContainEqual({ kind: 'setThinkingLevel', value: 'high' });
});

test('session_start of a background session binds the spawner-registered identity', async () => {
	const bound: Array<string> = [];
	const made = makeSession({
		bindSession: (id: string) => {
			bound.push(id);
		},
		bindingOf: () => ({
			agent: 'worker',
			appFolder: '/app/1',
			recordPath: '/app/1/worker-bg001.jsonl',
			sessionId: 'worker-bg001',
		}),
	});
	const { ctx } = makeCtx({ hasUI: false });
	await made.fire('session_start', { type: 'session_start' }, ctx);
	expect(made.session.sessionId).toBe('worker-bg001');
	expect(bound).toEqual(['worker-bg001']);
});

test('before_agent_start builds the system prompt: meta, instructions, skills', async () => {
	const made = await startedSession({
		get: () => ({ description: 'd', extensions: [], prompts: ['be fast'] }),
	});
	const result = (
		await made.fire('before_agent_start', { type: 'before_agent_start' }, made.ctx)
	)[0] as {
		systemPrompt: string;
	};
	expect(result.systemPrompt).toContain('<meta>');
	expect(result.systemPrompt).toContain('`worker-abcde`');
	expect(result.systemPrompt).toContain('<instructions>');
	expect(result.systemPrompt).toContain('be fast');
	expect(result.systemPrompt).toContain('<available_skills>skill x</available_skills>');
});

test('the reminder carries the topic and talkable manifest, gated by the contributors', async () => {
	const root = mkdtempSync(join(tmpdir(), 'harness-session-'));
	try {
		const topic = join(root, 'topic.md');
		await Bun.write(topic, '# the topic');
		const made = await startedSession({
			registerViewing: () => ({
				agent: 'worker',
				appFolder: '/app/1',
				recordPath: '/app/1/worker-abcde.jsonl',
				sessionId: 'worker-abcde',
				topic,
			}),
			talkableFor: () => [
				`<agent>\n<id>${LEADER_ID}</id>\n<description>coordinator</description>\n<relation>leader</relation>\n</agent>`,
			],
		});
		const first = (await made.fire('context', { messages: [] }, made.ctx))[0] as {
			messages: Array<{ content: Array<{ text: string }> }>;
		};
		const body = first.messages.at(-1)?.content[0]?.text ?? '';
		expect(body).toContain('<system-reminder>');
		expect(body).toContain('# the topic');
		expect(body).toContain('<talkable-agents>');
		expect(body).toContain(LEADER_ID);
		// Immediately again: the contributors' own intervals gate them out, and
		// With no other contributor the reminder is empty.
		const second = (await made.fire('context', { messages: [] }, made.ctx))[0];
		expect(second).toEqual({});
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('human input is transformed into a leader talk and names the app session', async () => {
	const captured: Array<string> = [];
	const made = makeSession({
		captureFirstMessage: (text: string) => {
			captured.push(text);
		},
	});
	const { ctx } = makeCtx();
	await made.fire('session_start', { type: 'session_start' }, ctx);
	const result = (await made.fire('input', { source: 'interactive', text: 'hello' }, ctx))[0];
	expect(result).toEqual({ action: 'transform', text: '[leader] hello' });
	expect(captured).toEqual(['hello']);
});

test('the talk tool delivers through the kernel once bound', async () => {
	const talked: Array<[string, string, string]> = [];
	const made = await startedSession({
		deliverTalk: (from: string, to: string, message: string) => {
			talked.push([from, to, message]);
		},
	});
	const result = await made.tools.get('talk')?.execute('t1', { message: 'go', to: 'other-1' });
	expect(result).toEqual({
		content: [{ text: 'talked to other-1', type: 'text' }],
		details: undefined,
	});
	expect(talked).toEqual([['worker-abcde', 'other-1', 'go']]);
});

test('deliver steers a streaming live session, prompts an idle one, sends foreground otherwise', async () => {
	const actions: Array<string> = [];
	const live = (streaming: boolean): LiveSession => ({
		dispose: () => {},
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
	});
	// Foreground (no live): sendMessage with the rendered talk message.
	const foreground = await startedSession();
	foreground.session.deliver('a-1', 'colleague', 'hi');
	expect(foreground.calls.some((c) => c.kind === 'sendMessage')).toBe(true);
	// Live streaming: steer notice; live idle: prompt notice.
	const streaming = (await startedSession()).session;
	streaming.attachLive(live(true));
	streaming.deliver(LEADER_ID, 'leader', 'mid-turn');
	const idle = (await startedSession()).session;
	idle.attachLive(live(false));
	idle.deliver(LEADER_ID, 'leader', 'wake up');
	expect(actions).toEqual([
		`steer:[talk from \`${LEADER_ID}\` (leader)] mid-turn`,
		`prompt:[talk from \`${LEADER_ID}\` (leader)] wake up`,
	]);
});

test('the reminder content is gathered through the system-reminder event', async () => {
	const made = await startedSession();
	made.pi.events.on(SYSTEM_REMINDER_CHANNEL, (data) => {
		(data as { text: string }).text += 'extension contribution';
	});
	const first = (await made.fire('context', { messages: [] }, made.ctx))[0] as {
		messages: Array<{ content: Array<{ text: string }> }>;
	};
	const body = first.messages.at(-1)?.content[0]?.text ?? '';
	expect(body).toContain('extension contribution');
	expect(body.startsWith('<system-reminder>\n')).toBe(true);
	expect(body.endsWith('\n</system-reminder>')).toBe(true);
});

test('info dispatches the talkable event on the session bus and returns the mutated payload', async () => {
	const made = await startedSession();
	made.pi.events.on(TALKABLE_INFO_CHANNEL, (data) => {
		(data as { text: string }).text = 'mutated';
	});
	expect(made.session.info('base')).toBe('mutated');
	expect(
		made.calls.some(
			(c) =>
				c.kind === 'event' &&
				(c.value as { channel: string }).channel === TALKABLE_INFO_CHANNEL,
		),
	).toBe(true);
});

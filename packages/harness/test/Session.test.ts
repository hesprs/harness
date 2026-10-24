import Session from '@/Session';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { LEADER_ID, TALKABLE_INFO_CHANNEL } from '@repo/shared/contract';
import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import type { Kernel } from '@';
import type { LiveSession } from '@/Sessions';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Extension } from '@repo/shared/contract';

/** Capturing ExtensionAPI stub: registered handlers and tools are invocable. */
function makePi() {
	const calls: Array<{ kind: string; value: unknown }> = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const tools = new Map<string, { execute: (id: string, params: unknown) => Promise<unknown> }>();
	const eventListeners = new Map<string, Array<(data: unknown) => void>>();
	let active = ['talk'];
	const seen = new Set<string>();
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
		getActiveTools: () => active,
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand: () => {},
		registerEntryRenderer: () => {},
		registerMessageRenderer: () => {},
		registerTool: (tool: {
			defaultActive?: boolean;
			exposure?: string;
			name: string;
			execute: (id: string, params: unknown) => Promise<unknown>;
		}) => {
			tools.set(tool.name, tool);
			// Pi activates a registered tool only while its name is new to the registry.
			if (seen.has(tool.name)) return;
			seen.add(tool.name);
			const exposure = tool.exposure ?? 'direct';
			if (tool.defaultActive === false) return;
			if (exposure === 'direct' || exposure === 'model-only') active = [...active, tool.name];
		},
		sendMessage: (message: unknown, options: unknown) => {
			calls.push({ kind: 'sendMessage', value: { message, options } });
			return Promise.resolve();
		},
		setActiveTools: (names: Array<string>) => {
			calls.push({ kind: 'setActiveTools', value: names });
			active = names;
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
		active: () => active,
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

test('shifting back to an agent re-activates the tools its extensions registered', async () => {
	const tool =
		(name: string): Extension =>
		(pi) => {
			pi.registerTool(
				defineTool({
					description: name,
					async execute() {
						return { content: [{ text: name, type: 'text' }], details: undefined };
					},
					label: name,
					name,
					parameters: Type.Object({}),
				}),
			);
		};
	let current = 'first';
	const made = makeSession({
		bindByFile: () =>
			Promise.resolve({
				agent: current,
				appFolder: '/app/1',
				recordPath: '/app/1/worker-abcde.jsonl',
				sessionId: 'worker-abcde',
			}),
		get: (agent: string) => ({
			description: 'd',
			extensions: [tool(`${agent}-tool`)],
			prompts: [],
		}),
	});
	const { ctx } = makeCtx();
	await made.fire('session_start', { type: 'session_start' }, ctx);
	current = 'second';
	await made.fire('session_start', { type: 'session_start' }, ctx);
	expect(made.active()).toContain('second-tool');
	current = 'first';
	await made.fire('session_start', { type: 'session_start' }, ctx);
	expect(made.active()).toEqual(expect.arrayContaining(['first-tool']));
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

test('before_agent_start sets customPrompt with meta and instructions', async () => {
	const made = await startedSession({
		get: () => ({ description: 'd', extensions: [], prompts: ['be fast'] }),
	});
	const event = {
		systemPromptOptions: {
			customPrompt: undefined as string | undefined,
			sections: {} as Record<string, string>,
		},
	};
	await made.fire('before_agent_start', event, made.ctx);
	expect(event.systemPromptOptions.customPrompt).toContain('<meta>');
	expect(event.systemPromptOptions.customPrompt).toContain('`worker-abcde`');
	expect(event.systemPromptOptions.customPrompt).toContain('<instructions>');
	expect(event.systemPromptOptions.customPrompt).toContain('be fast');
});

test('before_agent_start sets topic and talkables sections', async () => {
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
		const event = {
			systemPromptOptions: {
				customPrompt: undefined as string | undefined,
				sections: {} as Record<string, string>,
			},
		};
		await made.fire('before_agent_start', event, made.ctx);
		expect(event.systemPromptOptions.sections.topic).toBe('# the topic');
		expect(event.systemPromptOptions.sections.talkables).toContain(LEADER_ID);
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
			return Promise.resolve('queued');
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

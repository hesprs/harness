import toolSpawn from '@/tools/spawn';
import { test, expect } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { KernelContract } from '@repo/shared/contract';

/** Capturing pi stub: registered tools are invocable. */
type Tool = {
	execute: (
		id: string,
		params: unknown,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<unknown>;
	name: string;
};

function makePi() {
	const tools = new Map<string, Tool>();
	const pi = {
		on: () => {},
		registerTool: (tool: Tool) => {
			tools.set(tool.name, tool);
		},
	};
	return { pi: pi as unknown as ExtensionAPI, tools };
}

/** Kernel stub recording spawn calls and delivered prompts. */
function makeKernel() {
	const spawned: Array<[string, string, string | undefined, string | undefined]> = [];
	const delivered: Array<[string, string, string]> = [];
	return {
		delivered,
		kernel: {
			appFolder: () => '/app/1',
			bindingOf: (piSessionId: string) =>
				piSessionId === 'pi-1'
					? { appFolder: '/app/1', sessionId: 'spawner-1' }
					: undefined,
			defineAgent: () => '',
			defineBaseAgent: () => {},
			deliverTalk: (from: string, to: string, message: string) => {
				delivered.push([from, to, message]);
				return Promise.resolve();
			},
			get: () => {},
			spawn: (from: string, agent: string, topic?: string, id?: string) => {
				spawned.push([from, agent, topic, id]);
				return Promise.resolve({
					recordPath: `/app/1/${id ?? 'auto-1'}.jsonl`,
					sessionId: id ?? 'auto-1',
				});
			},
		} as KernelContract,
		spawned,
	};
}

async function setup() {
	const made = makeKernel();
	(globalThis as { harnessKernel?: KernelContract }).harnessKernel = made.kernel;
	const { pi, tools } = makePi();
	await toolSpawn(['worker'])(pi);
	const ctx = { sessionManager: { getSessionId: () => 'pi-1' } };
	return { ctx, tools, ...made };
}

test('spawn passes the chosen id to the kernel and delivers the starting prompt', async () => {
	const { ctx, delivered, spawned, tools } = await setup();
	const result = (await tools
		.get('spawn')
		?.execute(
			't1',
			{ agent: 'worker', id: 'builder-1', prompt: 'dig in' },
			undefined,
			undefined,
			ctx,
		)) as {
		content: Array<{ text: string }>;
		structuredContent: { recordPath: string; sessionId: string };
	};
	expect(spawned).toEqual([['spawner-1', 'worker', undefined, 'builder-1']]);
	expect(delivered).toEqual([['spawner-1', 'builder-1', 'dig in']]);
	expect(JSON.parse(result.content[0]?.text ?? '')).toEqual({
		recordPath: '/app/1/builder-1.jsonl',
		sessionId: 'builder-1',
	});
	expect(result.structuredContent).toEqual({
		recordPath: '/app/1/builder-1.jsonl',
		sessionId: 'builder-1',
	});
});

test('spawn without a custom id leaves the kernel id argument undefined', async () => {
	const { ctx, spawned, tools } = await setup();
	await tools
		.get('spawn')
		?.execute('t1', { agent: 'worker', prompt: 'go' }, undefined, undefined, ctx);
	expect(spawned).toEqual([['spawner-1', 'worker', undefined, undefined]]);
});

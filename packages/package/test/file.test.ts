import { toolFile } from '@/tools/file/index.ts';
import { test, expect } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** The model fields the GPT check reads. */
type ModelLike = { api?: string; id: string; provider: string };

const GPT_MODEL: ModelLike = { api: 'openai-responses', id: 'gpt-6.1-sol', provider: 'openai' };
const OTHER_MODEL: ModelLike = { api: 'zai', id: 'glm-5.3', provider: 'zai' };

/** Capturing pi stub: registered tools, the active-tool list, and invocable event handlers. */
function makePi(initial: Array<string> = ['read']) {
	const registered: Array<string> = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	let active = [...initial];
	const pi = {
		getActiveTools: () => [...active],
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool: (tool: { name: string }) => {
			registered.push(tool.name);
		},
		setActiveTools: (names: Array<string>) => {
			active = [...names];
		},
	};
	const fire = (event: string, model?: ModelLike) =>
		Promise.all(
			(handlers.get(event) ?? []).map((handler) =>
				handler(event === 'model_select' ? { model } : {}, { model }),
			),
		);
	return { active: () => [...active], fire, pi: pi as unknown as ExtensionAPI, registered };
}

test('registers apply_patch, edit, and delete; write stays a built-in activated by name', async () => {
	const { pi, registered } = makePi();
	await toolFile(pi);
	expect(registered.sort()).toEqual(['apply_patch', 'delete', 'edit']);
});

test('a GPT model gets apply_patch only, keeping unrelated tools', async () => {
	const harness = makePi(['read', 'write', 'edit', 'delete', 'codemode']);
	await toolFile(harness.pi);
	await harness.fire('model_select', GPT_MODEL);
	expect([...harness.active()].sort()).toEqual(['apply_patch', 'codemode', 'read']);
});

test('a non-GPT model gets write, edit, delete and loses apply_patch', async () => {
	const harness = makePi(['read', 'apply_patch']);
	await toolFile(harness.pi);
	await harness.fire('session_start', OTHER_MODEL);
	expect([...harness.active()].sort()).toEqual(['delete', 'edit', 'read', 'write']);
});

test('a gpt id on any provider qualifies through the OpenAI Responses api', async () => {
	const harness = makePi();
	await toolFile(harness.pi);
	await harness.fire('before_agent_start', {
		api: 'openai-responses',
		id: 'gpt-5',
		provider: 'my-proxy',
	});
	expect([...harness.active()].sort()).toEqual(['apply_patch', 'read']);
});

test('a non-gpt id on the openai provider keeps the write toolset', async () => {
	const harness = makePi();
	await toolFile(harness.pi);
	await harness.fire('model_select', { api: 'openai-responses', id: 'o3', provider: 'openai' });
	expect([...harness.active()].sort()).toEqual(['delete', 'edit', 'read', 'write']);
});

test('without a model the write toolset is active', async () => {
	const harness = makePi(['read', 'apply_patch']);
	await toolFile(harness.pi);
	await harness.fire('session_start');
	expect([...harness.active()].sort()).toEqual(['delete', 'edit', 'read', 'write']);
});

test('switching models swaps the toolset without accumulating', async () => {
	const harness = makePi();
	await toolFile(harness.pi);
	await harness.fire('model_select', GPT_MODEL);
	await harness.fire('model_select', OTHER_MODEL);
	await harness.fire('before_agent_start', GPT_MODEL);
	expect([...harness.active()].sort()).toEqual(['apply_patch', 'read']);
});

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { test, expect } from 'bun:test';
import Agents, { registry } from '@/Agents';

function makePi() {
	const calls: Array<[string, unknown]> = [];
	const extensions: Array<string> = [];
	return {
		calls,
		extensions,
		pi: {
			getActiveTools: () => [],
			registerTool: () => {},
			setActiveTools: (tools: Array<string>) => {
				calls.push(['setActiveTools', tools]);
			},
			setModel: (model: unknown) => {
				calls.push(['setModel', model]);
			},
			setThinkingLevel: (level: unknown) => {
				calls.push(['setThinkingLevel', level]);
			},
		} as unknown as ExtensionAPI,
	};
}

function modelRegistry(modelId: string): Pick<ExtensionContext, 'modelRegistry'> {
	return {
		modelRegistry: {
			find: (_provider: string, id: string) => ({ id: modelId ?? id }),
		} as unknown as ExtensionContext['modelRegistry'],
	};
}

const NAME = 'agents-test-coder';

test('apply activates talk, definition extensions, model and thinking', async () => {
	registry.setScope('user');
	const extension = (pi: ExtensionAPI) => {
		void pi;
	};
	registry.defineAgent({
		description: 'writes code',
		extensions: [extension],
		model: 'anthropic/claude-test',
		name: NAME,
		thinking: 'high',
	});
	const agents = new Agents({ registerSection: () => {} });
	const { calls, pi } = makePi();
	await agents.root.apply(pi, modelRegistry('claude-test'), NAME);
	expect(calls).toContainEqual(['setActiveTools', ['talk']]);
	expect(calls).toContainEqual(['setModel', { id: 'claude-test' }]);
	expect(calls).toContainEqual(['setThinkingLevel', 'high']);
});

test('apply skips the model when the definition has no provider/id pair', async () => {
	registry.setScope('user');
	registry.defineAgent({ description: 'd', name: 'agents-test-plain' });
	const agents = new Agents({ registerSection: () => {} });
	const { calls, pi } = makePi();
	await agents.root.apply(pi, modelRegistry(''), 'agents-test-plain');
	expect(calls).toContainEqual(['setActiveTools', ['talk']]);
	expect(calls.some(([kind]) => kind === 'setModel')).toBe(false);
});

test('apply with an unknown agent still activates the talk tool', async () => {
	const agents = new Agents({ registerSection: () => {} });
	const { calls, pi } = makePi();
	await agents.root.apply(pi, modelRegistry(''), 'agents-test-unknown');
	expect(calls).toContainEqual(['setActiveTools', ['talk']]);
});

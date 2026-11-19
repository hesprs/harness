// oxlint-disable capitalized-comments
import {
	defineAgent,
	defineBaseAgent,
	skill,
	toolBash,
	toolCodemode,
	toolFetch,
	toolFile,
	toolFind,
	toolGrep,
	toolRead,
	toolSearch,
	mcp,
	toolImageGen,
	toolSpawn,
} from '@hesprs/harness';
import { resolve } from 'node:path';

const p = (path: string) => resolve(import.meta.dirname, path);
const content = (path: string) => Bun.file(p(path)).text();
const [workerPrompt, explorerPrompt, chancellorPrompt, globalPrompt] = await Promise.all([
	content('./agents/worker.md'),
	content('./agents/explorer.md'),
	content('./agents/chancellor.md'),
	content('./AGENTS.md'),
]);

process.loadEnvFile(p('.env'));
const SNOWLUMA_MCP_TOKEN = process.env.SNOWLUMA_MCP_TOKEN;
if (!SNOWLUMA_MCP_TOKEN) throw new Error('No Snowluma token!');

defineBaseAgent({
	extensions: [
		skill([p('./skills/general'), p('./skills/commands')]),
		toolCodemode,
		toolBash,
		toolFetch,
		toolRead,
		toolSearch,
		toolFind,
		toolGrep,
		toolFile,
	],
	model: 'zai/glm-5.3',
	prompt: globalPrompt,
});

const worker = defineAgent({
	description:
		'Fast execution specialist. Receives complete context and task spec, completes defined tasks efficiently.',
	name: 'worker',
	prompt: workerPrompt,
	thinking: 'high',
});

const explorer = defineAgent({
	description:
		'Context-heavy work specialist for fast local codebase, files, external resource and documentation search and analysis.',
	name: 'explorer',
	prompt: explorerPrompt,
	thinking: 'medium',
});

defineAgent({
	description: 'The orchestrator.',
	extensions: [
		toolSpawn([worker, explorer]),
		skill(p('./skills/capabilities')),
		toolImageGen,
		mcp({
			'cua-driver': {
				args: ['mcp'],
				command: 'cua-driver',
				env: { CUA_DRIVER_RS_ENABLE_WAYLAND: '1' },
			},
			snowluma: {
				args: ['@snowluma/mcp@2.3.4'],
				command: 'bunx',
				env: {
					SNOWLUMA_MCP_ENDPOINT: 'http://127.0.0.1:3000/',
					SNOWLUMA_MCP_MODE: 'write',
					SNOWLUMA_MCP_TOKEN,
				},
			},
		}),
	],
	model: 'openai/gpt-6.1-sol',
	name: 'chancellor',
	prompt: chancellorPrompt,
	thinking: 'high',
});

import {
	defineAgent,
	defineBaseAgent,
	skill,
	toolBash,
	toolDelete,
	toolEdit,
	toolFetch,
	toolFind,
	toolGrep,
	toolRead,
	toolSearch,
	toolWrite,
} from '@hesprs/harness';
import { resolve } from 'node:path';

const p = (path: string) => resolve(import.meta.dirname, path);
const content = (path: string) => Bun.file(p(path)).text();
const [workerPrompt, globalPrompt] = await Promise.all([
	content('./agent/worker.md'),
	content('./AGENTS.md'),
]);

defineBaseAgent({
	extensions: [skill(p('./skill/customize-pi.md'))],
	model: 'zai/glm-5.3',
	prompt: globalPrompt,
	thinking: 'high',
});

defineAgent({
	description:
		'Fast execution specialist. Receives complete context and task spec, completes defined task efficiently.',
	extensions: [
		toolBash,
		toolDelete,
		toolFetch,
		toolRead,
		toolSearch,
		toolWrite,
		toolEdit,
		toolFind,
		toolGrep,
		skill([
			p('./skill/manage-pty.md'),
			p('./skill/write-code.md'),
			p('./skill/write-tests.md'),
			p('./skill/query-docs'),
		]),
	],
	model: 'zai/glm-5.3',
	name: 'worker',
	prompt: workerPrompt,
	thinking: 'high',
});

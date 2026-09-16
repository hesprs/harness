import {
	defineAgent,
	defineBaseAgent,
	skill,
	toolApplyPatch,
	toolBash,
	toolFetch,
	toolFind,
	toolGrep,
	toolRead,
	toolSearch,
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
		'Fast execution specialist. Receives complete context and task spec, completes defined tasks efficiently.',
	extensions: [
		toolBash,
		toolFetch,
		toolRead,
		toolSearch,
		toolApplyPatch,
		toolFind,
		toolGrep,
		skill([
			p('./skill/manage-pty.md'),
			p('./skill/write-code.md'),
			p('./skill/write-tests.md'),
			p('./skill/query-docs'),
		]),
	],
	model: 'zai/glm-5.3-flash',
	name: 'worker',
	prompt: workerPrompt,
	thinking: 'high',
});

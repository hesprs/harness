// oxlint-disable capitalized-comments
import {
	defineAgent,
	defineBaseAgent,
	skill,
	// toolApplyPatch,
	toolBash,
	toolCodemode,
	toolDelete,
	toolEdit,
	toolWrite,
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
	model: 'zai/glm-5.3',
	prompt: globalPrompt,
	thinking: 'high',
});

defineAgent({
	description:
		'Fast execution specialist. Receives complete context and task spec, completes defined tasks efficiently.',
	extensions: [
		toolCodemode(),
		toolBash,
		toolFetch,
		toolRead,
		toolSearch,
		toolWrite,
		toolEdit,
		toolDelete,
		// toolApplyPatch,
		toolFind,
		toolGrep,
		skill(p('./skill')),
	],
	name: 'worker',
	prompt: workerPrompt,
	thinking: 'high',
});

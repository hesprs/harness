import type { Plugin } from '@opencode-ai/plugin';
import { createTaskSessionManagerHook } from './task-manager';

const subagentResume: Plugin = async (ctx) =>
	createTaskSessionManagerHook(ctx, {
		maxSessionsPerAgent: 2,
		readContextMaxFiles: 8,
		readContextMinLines: 10,
	});

export default subagentResume;

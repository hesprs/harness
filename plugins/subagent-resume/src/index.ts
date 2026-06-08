import type { Plugin } from '@opencode-ai/plugin';
import { createTaskSessionManagerHook } from './task-manager';
import { createAppLogger } from './utils/app-log';

const subagentResume: Plugin = async (ctx) => {
	const log = createAppLogger(ctx);
	await log('info', 'plugin init start');
	const hooks = createTaskSessionManagerHook(ctx, log, {
		maxSessionsPerAgent: 2,
		readContextMaxFiles: 8,
		readContextMinLines: 10,
	});
	await log('info', 'plugin init finish');
	return hooks;
};

export default subagentResume;

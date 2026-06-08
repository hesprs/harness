import type { PluginInput } from '@opencode-ai/plugin';

export type AppLogLevel = 'info' | 'warn' | 'error';

export type AppLogger = (level: AppLogLevel, message: string) => Promise<void>;

export function createAppLogger(ctx: PluginInput): AppLogger {
	return async (level, message) => {
		try {
			await ctx.client.app.log({
				body: {
					level,
					message,
					service: 'subagent-resume',
				},
			});
		} catch {
			const prefix = level === 'error' ? 'ERROR' : level === 'warn' ? 'WARN' : 'INFO';
			const fallback =
				level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
			fallback(`[subagent-resume] ${prefix}: ${message}`);
		}
	};
}

import type { Hooks, PluginInput } from '@opencode-ai/plugin';
import path from 'node:path';
import type { ContextFile } from './utils';
import type { AppLogger } from './utils/app-log';
import {
	deriveTaskSessionLabel,
	parseTaskIdFromTaskOutput,
	SessionManager,
	SLIM_INTERNAL_INITIATOR_MARKER,
} from './utils';

type TaskArgs = {
	description?: unknown;
	prompt?: unknown;
	subagent_type?: unknown;
	task_id?: unknown;
};

type PendingTaskCall = {
	callId: string;
	parentSessionId: string;
	agentType: string;
	label: string;
	resumedTaskId?: string;
};

const MAX_PENDING_TASK_CALLS = 100;

type PendingContextFile = {
	path: string;
	lines: Set<number>;
	lastReadAt: number;
};

const RESUMABLE_SESSIONS_START = '<resumable_sessions>';
const RESUMABLE_SESSIONS_END = '</resumable_sessions>';

function extractPath(output: string): string | undefined {
	return /<path>(?<path>[^<]+)<\/path>/.exec(output)?.groups?.path;
}

function normalizePath(root: string, file: string): string {
	const relative = path.relative(root, file);

	if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return file;

	return relative;
}

function extractReadFiles(root: string, output: { output: unknown }): Array<ContextFile> {
	if (typeof output.output !== 'string') return [];

	const file = extractPath(output.output);

	if (!file) return [];

	const lineNumbers = countReadLines(output.output);

	return [
		{
			lastReadAt: Date.now(),
			lineCount: lineNumbers.length,
			lineNumbers,
			path: normalizePath(root, file),
		},
	];
}

function countReadLines(output: string): Array<number> {
	const lines = new Set<number>();

	for (const match of output.matchAll(/^(?<line>[0-9]+):/gm)) {
		const line = match.groups?.line;

		if (!line) continue;

		lines.add(Number(line));
	}

	return [...lines];
}

export default createTaskSessionManagerHook;

export function createTaskSessionManagerHook(
	ctx: PluginInput,
	logger: AppLogger,
	options: {
		maxSessionsPerAgent: number;
		readContextMinLines?: number;
		readContextMaxFiles?: number;
	},
): Hooks {
	const sessionManager = new SessionManager(options.maxSessionsPerAgent, {
		readContextMaxFiles: options.readContextMaxFiles,
		readContextMinLines: options.readContextMinLines,
	});
	const pendingCalls = new Map<string, PendingTaskCall>();
	const pendingCallOrder: Array<string> = [];
	const contextByTask = new Map<string, Map<string, PendingContextFile>>();
	const pendingManagedTaskIds = new Set<string>();
	let anonymousPendingCallId = 0;

	function addTaskContext(taskId: string, files: Array<ContextFile>): void {
		if (files.length === 0) return;

		let context = contextByTask.get(taskId);

		if (!context) {
			context = new Map();
			contextByTask.set(taskId, context);
		}

		for (const file of files) {
			const pending = context.get(file.path) ?? {
				lastReadAt: file.lastReadAt,
				lines: new Set<number>(),
				path: file.path,
			};

			for (const line of file.lineNumbers ?? []) pending.lines.add(line);

			pending.lastReadAt = Math.max(pending.lastReadAt, file.lastReadAt);
			context.set(file.path, pending);
		}

		sessionManager.addContext(
			taskId,
			[...context.values()].map((file) => ({
				lastReadAt: file.lastReadAt,
				lineCount: file.lines.size,
				path: file.path,
			})),
		);
	}

	function canTrackTaskContext(taskId: string): boolean {
		return pendingManagedTaskIds.has(taskId) || sessionManager.taskIds().has(taskId);
	}

	function pruneContext(): void {
		const remembered = sessionManager.taskIds();

		for (const taskId of contextByTask.keys())
			if (!pendingManagedTaskIds.has(taskId) && !remembered.has(taskId))
				contextByTask.delete(taskId);
	}

	function isMissingRememberedSessionError(output: string): boolean {
		const firstLine = output.split(/\r?\n/, 1)[0]?.trim().toLowerCase() ?? '';

		return (
			firstLine.startsWith('[error]') &&
			firstLine.includes('session') &&
			(firstLine.includes('not found') || firstLine.includes('no session'))
		);
	}

	function pendingCallId(input: { callID?: string; sessionID?: string }): string {
		return (
			input.callID ?? `${input.sessionID ?? 'unknown'}:anonymous-${++anonymousPendingCallId}`
		);
	}

	function rememberPendingCall(call: PendingTaskCall): void {
		const existingIndex = pendingCallOrder.indexOf(call.callId);

		if (existingIndex !== -1) pendingCallOrder.splice(existingIndex, 1);

		pendingCalls.set(call.callId, call);
		pendingCallOrder.push(call.callId);

		while (pendingCallOrder.length > MAX_PENDING_TASK_CALLS) {
			const evictedCallId = pendingCallOrder.shift();

			if (!evictedCallId) break;

			pendingCalls.delete(evictedCallId);
		}
	}

	function takePendingCall(
		callId?: string,
		parentSessionId?: string,
	): PendingTaskCall | undefined {
		const resolvedCallId = callId ?? firstPendingCallForParent(parentSessionId);

		if (!resolvedCallId) return undefined;

		const pending = pendingCalls.get(resolvedCallId);
		pendingCalls.delete(resolvedCallId);

		const orderIndex = pendingCallOrder.indexOf(resolvedCallId);

		if (orderIndex !== -1) pendingCallOrder.splice(orderIndex, 1);

		return pending;
	}

	function firstPendingCallForParent(parentSessionId?: string): string | undefined {
		if (!parentSessionId) return undefined;

		return pendingCallOrder.find(
			(callId) => pendingCalls.get(callId)?.parentSessionId === parentSessionId,
		);
	}

	return {
		event: async (input: Parameters<NonNullable<Hooks['event']>>[0]): Promise<void> => {
			if (input.event.type === 'session.created') {
				const info = input.event.properties?.info as
					| { id?: string; parentID?: string }
					| undefined;

				if (info?.id && info.parentID) {
					const hasPendingParentCall = pendingCallOrder.some(
						(callId) => pendingCalls.get(callId)?.parentSessionId === info.parentID,
					);

					if (hasPendingParentCall) pendingManagedTaskIds.add(info.id);
				}

				return;
			}

			if (input.event.type !== 'session.deleted') return;

			const properties = input.event.properties as
				| { info?: { id?: string }; sessionID?: string }
				| undefined;
			const sessionId = properties?.info?.id ?? properties?.sessionID;

			if (!sessionId) return;

			sessionManager.dropTask(sessionId);
			sessionManager.clearParent(sessionId);
			contextByTask.delete(sessionId);
			pendingManagedTaskIds.delete(sessionId);
			pruneContext();

			for (const [callId, pending] of pendingCalls.entries()) {
				if (pending.parentSessionId !== sessionId) continue;

				takePendingCall(callId);
			}
		},

		'experimental.chat.messages.transform': async (
			_input: Parameters<NonNullable<Hooks['experimental.chat.messages.transform']>>[0],
			output: Parameters<NonNullable<Hooks['experimental.chat.messages.transform']>>[1],
		): Promise<void> => {
			for (let i = output.messages.length - 1; i >= 0; i -= 1) {
				const message = output.messages[i];
				if (!message) continue;
				if (message.info.role !== 'user') continue;
				if (!message.info.sessionID) return;
				const reminder = sessionManager.formatForPrompt(message.info.sessionID);
				if (!reminder) return;
				const textPart = message.parts.find((part) => part.type === 'text');
				if (!textPart || typeof textPart.text !== 'string') return;
				if (textPart.text.includes(SLIM_INTERNAL_INITIATOR_MARKER)) return;
				if (textPart.text.includes(RESUMABLE_SESSIONS_START)) return;
				textPart.text = [
					textPart.text,
					'',
					RESUMABLE_SESSIONS_START,
					reminder,
					RESUMABLE_SESSIONS_END,
				].join('\n');
				return;
			}
		},

		'tool.execute.after': async (
			input: Parameters<NonNullable<Hooks['tool.execute.after']>>[0],
			output: Parameters<NonNullable<Hooks['tool.execute.after']>>[1],
		): Promise<void> => {
			if (input.tool.toLowerCase() === 'read') {
				if (input.sessionID && canTrackTaskContext(input.sessionID))
					addTaskContext(input.sessionID, extractReadFiles(ctx.directory, output));

				return;
			}

			if (input.tool.toLowerCase() !== 'task') return;

			const pending = takePendingCall(input.callID, input.sessionID);

			if (!pending) {
				void logger(
					'warn',
					`tool.after task missing pending call callId=${input.callID ?? 'unknown'}`,
				);
				return;
			}

			if (typeof output.output !== 'string') {
				void logger(
					'warn',
					`tool.after task missing string output callId=${pending.callId}`,
				);
				return;
			}

			const taskId = parseTaskIdFromTaskOutput(output.output);

			if (!taskId) {
				void logger(
					'warn',
					`tool.after task missing taskId callId=${pending.callId} resumedTaskId=${pending.resumedTaskId ?? 'none'}`,
				);

				if (pending.resumedTaskId && isMissingRememberedSessionError(output.output))
					sessionManager.drop(
						pending.parentSessionId,
						pending.agentType,
						pending.resumedTaskId,
					);

				return;
			}

			if (pending.resumedTaskId && pending.resumedTaskId !== taskId)
				sessionManager.drop(
					pending.parentSessionId,
					pending.agentType,
					pending.resumedTaskId,
				);

			sessionManager.remember({
				agentType: pending.agentType,
				label: pending.label,
				parentSessionId: pending.parentSessionId,
				taskId,
			});
			pendingManagedTaskIds.delete(taskId);
			const context = contextByTask.get(taskId);

			sessionManager.addContext(
				taskId,
				context
					? [...context.values()].map((file) => ({
							lastReadAt: file.lastReadAt,
							lineCount: file.lines.size,
							path: file.path,
						}))
					: [],
			);
			pruneContext();
		},

		'tool.execute.before': async (
			input: Parameters<NonNullable<Hooks['tool.execute.before']>>[0],
			output: Parameters<NonNullable<Hooks['tool.execute.before']>>[1],
		): Promise<void> => {
			if (input.tool.toLowerCase() !== 'task') return;
			if (!input.sessionID) return;
			if (typeof output.args !== 'object' || output.args === null) return;
			const args = output.args as TaskArgs;

			if (typeof args.subagent_type !== 'string') {
				void logger('warn', 'tool.before task missing subagent_type');
				return;
			}

			const label = deriveTaskSessionLabel({
				agentType: args.subagent_type,
				description: typeof args.description === 'string' ? args.description : undefined,
				prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
			});

			const pendingCall: PendingTaskCall = {
				agentType: args.subagent_type,
				callId: pendingCallId({
					callID: input.callID,
					sessionID: input.sessionID,
				}),
				label,
				parentSessionId: input.sessionID,
			};
			rememberPendingCall(pendingCall);

			if (typeof args.task_id !== 'string' || args.task_id.trim() === '') return;

			const requested = args.task_id.trim();
			const remembered = sessionManager.resolve(
				input.sessionID,
				args.subagent_type,
				requested,
			);

			if (!remembered) {
				void logger(
					'warn',
					`tool.before task resume miss taskId=${requested} agentType=${args.subagent_type}`,
				);
				delete args.task_id;
				return;
			}

			args.task_id = remembered.taskId;
			pendingManagedTaskIds.add(remembered.taskId);
			sessionManager.markUsed(input.sessionID, args.subagent_type, remembered.taskId);
			pendingCall.resumedTaskId = remembered.taskId;
			rememberPendingCall(pendingCall);
		},
	};
}

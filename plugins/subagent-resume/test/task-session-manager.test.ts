import { expect, test } from 'bun:test';
import { createTaskSessionManagerHook } from '../src/task-manager';

function createHook() {
	return createTaskSessionManagerHook({ directory: '/tmp' } as never, async () => {}, {
		maxSessionsPerAgent: 2,
		readContextMaxFiles: 8,
		readContextMinLines: 10,
	});
}

function createMessage(sessionID: string, text = 'do something') {
	return {
		messages: [
			{
				info: { agent: 'orchestrator', role: 'user', sessionID },
				parts: [{ text, type: 'text' }],
			},
		],
	};
}

const taskOutput = [
	'<task id="child-1" state="completed">',
	'<task_result>',
	'done',
	'</task_result>',
	'</task>',
].join('\n');

async function completeTask(
	hook: ReturnType<typeof createHook>,
	sessionID: string,
	description: string,
) {
	const before = hook['tool.execute.before'];
	const after = hook['tool.execute.after'];

	if (!before || !after) throw new Error('missing hook');

	await before(
		{ callID: 'call-1', sessionID, tool: 'task' },
		{ args: { description, subagent_type: 'explorer' } },
	);
	await after(
		{ args: {}, callID: 'call-1', sessionID, tool: 'task' },
		{
			metadata: {},
			output: taskOutput,
			title: 'task',
		},
	);
}

test('injects resumable sessions after completed task', async () => {
	const hook = createHook();
	const transform = hook['experimental.chat.messages.transform'];

	if (!transform) throw new Error('missing hook');

	await completeTask(hook, 'parent-1', 'config schema');

	const messages = createMessage('parent-1');
	await transform({}, messages as never);
	const firstPart = messages.messages[0]!.parts[0] as { text: string };

	expect(firstPart.text).toContain('### Resumable Sessions');
	expect(firstPart.text).toContain('exp-1 config schema');
});

test('resolves alias before next task execution', async () => {
	const hook = createHook();
	const before = hook['tool.execute.before'];

	if (!before) throw new Error('missing hook');

	await completeTask(hook, 'parent-1', 'config schema');

	const next = {
		args: {
			description: 'continue schema work',
			subagent_type: 'explorer',
			task_id: 'exp-1',
		},
	};

	await before({ callID: 'call-2', sessionID: 'parent-1', tool: 'task' }, next);

	expect(next.args.task_id).toBe('child-1');
});

test('tracks read context from child session', async () => {
	const hook = createHook();
	const after = hook['tool.execute.after'];
	const transform = hook['experimental.chat.messages.transform'];
	const event = hook.event;

	if (!after || !transform || !event) throw new Error('missing hook');

	await completeTask(hook, 'parent-1', 'session files');
	await event({
		event: {
			properties: {
				info: {
					id: 'child-1',
					parentID: 'parent-1',
				},
			},
			type: 'session.created',
		},
	} as never);
	await after(
		{ args: {}, callID: 'read-1', sessionID: 'child-1', tool: 'read' },
		{
			metadata: {},
			output: [
				'<path>/tmp/src/index.ts</path>',
				'<content>',
				...Array.from({ length: 12 }, (_, index) => `${index + 1}: line`),
				'</content>',
			].join('\n'),
			title: 'read',
		},
	);

	const messages = createMessage('parent-1');
	await transform({}, messages as never);
	const firstPart = messages.messages[0]!.parts[0] as { text: string };

	expect(firstPart.text).toContain('Context read by exp-1: src/index.ts (12 lines)');
});

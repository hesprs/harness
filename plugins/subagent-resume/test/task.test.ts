import { expect, test } from 'bun:test';
import { parseTaskIdFromTaskOutput } from '../src/utils';

const cases = [
	{
		expected: 'session-abc-123',
		name: 'parses task id from task output',
		output: [
			'<task id="session-abc-123" state="completed">',
			'<task_result>',
			'done',
			'</task_result>',
			'</task>',
		].join('\n'),
	},
	{
		expected: 'session-abc-123',
		name: 'parses legacy task id line',
		output: 'task_id: session-abc-123 (for resuming to continue this task if needed)',
	},
	{
		expected: undefined,
		name: 'returns undefined without task id',
		output: '<task_result>no task id here</task_result>',
	},
] as const;

for (const { expected, name, output } of cases)
	test(name, () => {
		expect(parseTaskIdFromTaskOutput(output)).toBe(expected);
	});

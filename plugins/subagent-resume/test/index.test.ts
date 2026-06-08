import { expect, test } from 'bun:test';
import subagentResume from '../src/index';

test('returns hook map directly', async () => {
	const hooks = await subagentResume({} as never);

	expect(typeof hooks['tool.execute.before']).toBe('function');
	expect(typeof hooks['tool.execute.after']).toBe('function');
	expect(typeof hooks['experimental.chat.messages.transform']).toBe('function');
	expect(typeof hooks.event).toBe('function');
});

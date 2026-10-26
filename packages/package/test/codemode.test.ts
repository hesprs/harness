import { executeInBun } from '@/tools/codemode.ts';

const { test, expect } = await import('bun:test');

test('executeInBun reports single-line syntax errors with exact line and column', async () => {
	const result = await executeInBun(
		{ globals: [], timeoutMs: 5000, tools: [] },
		'const bad = { a: 1; });',
	);
	if (result.ok) throw new Error('Expected error result');
	expect(result.error.kind).toBe('script');
	expect(result.error.name).toBe('SyntaxError');
	expect(result.error.message).toContain('code contains 2 syntax errors');
	expect(result.error.message).toContain('line 1, column 19: Expected "}" but found ";"');
	expect(result.error.message).toContain('const bad = { a: 1; });');
});

test('executeInBun maps multi-line syntax errors to the script line numbers', async () => {
	const result = await executeInBun(
		{ globals: [], timeoutMs: 5000, tools: [] },
		'const ok = 1;\nconst bad = { a: 1; });',
	);
	if (result.ok) throw new Error('Expected error result');
	expect(result.error.message).toContain('line 2, column 19: Expected "}" but found ";"');
});

test('executeInBun reports the session stray-semicolon case', async () => {
	// Mirrors the real failure: a template literal closed with `;` inside an object argument.
	const result = await executeInBun(
		{ globals: [], timeoutMs: 5000, tools: [] },
		'await tools.apply_patch({ input: `x\n`; });',
	);
	if (result.ok) throw new Error('Expected error result');
	expect(result.error.kind).toBe('script');
	expect(result.error.message).toContain('line 2, column 2: Expected "}" but found ";"');
});

test('executeInBun still runs valid scripts and reports runtime errors', async () => {
	const ok = await executeInBun({ globals: [], timeoutMs: 5000, tools: [] }, 'return 1 + 1;');
	expect(ok.ok).toBe(true);
	if (ok.ok) expect(ok.value).toBe(2);

	const runtime = await executeInBun(
		{ globals: [], timeoutMs: 5000, tools: [] },
		"throw new TypeError('boom');",
	);
	if (runtime.ok) throw new Error('Expected error result');
	expect(runtime.error.name).toBe('TypeError');
	expect(runtime.error.message).toContain('boom');
});

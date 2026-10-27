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

test('executeInBun keeps import-like text in strings and comments intact', async () => {
	const code = [
		"const command = `import x from 'decoy';`;",
		"// import z from 'decoy3'",
		'return command;',
	].join('\n');
	const result = await executeInBun({ globals: [], timeoutMs: 5000, tools: [] }, code);
	if (!result.ok) throw new Error(result.error.message);
	expect(result.value).toBe("import x from 'decoy';");
});

test('executeInBun resolves static imports of installed packages', async () => {
	const code = [
		"import { join, basename } from 'node:path';",
		'return [join("a", "b"), basename("x/y")];',
	].join('\n');
	const result = await executeInBun({ globals: [], timeoutMs: 5000, tools: [] }, code);
	if (!result.ok) throw new Error(result.error.message);
	expect(result.value).toEqual(['a/b', 'y']);
});

test('executeInBun resolves multiline and mid-code static imports', async () => {
	const multiline = [
		'import {',
		'  join as j,',
		"} from 'node:path';",
		'return j("a", "c");',
	].join('\n');
	const midCode = [
		'const run = true;',
		"import { dirname } from 'node:path';",
		"return dirname('/a/b');",
	].join('\n');
	for (const [code, expected] of [
		[multiline, 'a/c'],
		[midCode, '/a'],
	] as Array<[string, string]>) {
		const result = await executeInBun({ globals: [], timeoutMs: 5000, tools: [] }, code);
		if (!result.ok) throw new Error(result.error.message);
		expect(result.value).toBe(expected);
	}
});

test('executeInBun skips type-only imports without resolving them', async () => {
	const result = await executeInBun(
		{ globals: [], timeoutMs: 5000, tools: [] },
		"import type { Missing } from './does-not-exist';\nreturn 42;",
	);
	if (!result.ok) throw new Error(result.error.message);
	expect(result.value).toBe(42);
});

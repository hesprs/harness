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
	expect(result.error.message).toContain('code contains 1 syntax error');
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

test('executeInBun runs TypeScript with top-level await and return', async () => {
	const code = [
		'interface Pair { left: number; right: number }',
		'const pair: Pair = { left: 1, right: 2 };',
		"const { join } = await import('node:path');",
		'return join(String(pair.left), String(pair.right));',
	].join('\n');
	const result = await executeInBun({ globals: [], timeoutMs: 5000, tools: [] }, code);
	if (!result.ok) throw new Error(result.error.message);
	expect(result.value).toBe('1/2');
});

test('executeInBun returns early from a conditional top-level return', async () => {
	const result = await executeInBun(
		{ globals: [], timeoutMs: 5000, tools: [] },
		"if (true) {\n  return 'early';\n}\nreturn 'late';",
	);
	if (!result.ok) throw new Error(result.error.message);
	expect(result.value).toBe('early');
});

/** Valid 1x1 PNG, so the emitted block decodes as a real image. */
const PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const runImage = (code: string, tools: Array<{ execute: () => unknown; name: string }> = []) =>
	executeInBun({ globals: [], timeoutMs: 5000, tools }, code);

test('image() shows a PNG passed as a base64 data URI string', async () => {
	const result = await runImage(`image('data:image/png;base64,${PNG}');`);
	if (!result.ok) throw new Error(result.error.message);
	expect(result.output).toEqual([{ data: PNG, mimeType: 'image/png', type: 'image' }]);
});

test('image() shows an image_url object carrying a data URI', async () => {
	const result = await runImage(`image({ image_url: 'data:image/png;base64,${PNG}' });`);
	if (!result.ok) throw new Error(result.error.message);
	expect(result.output).toEqual([{ data: PNG, mimeType: 'image/png', type: 'image' }]);
});

test('image() shows an image block with its mimeType', async () => {
	const result = await runImage(
		`image({ type: 'image', data: '${PNG}', mimeType: 'image/png' });`,
	);
	if (!result.ok) throw new Error(result.error.message);
	expect(result.output).toEqual([{ data: PNG, mimeType: 'image/png', type: 'image' }]);
});

test('image() shows an image block without a mimeType', async () => {
	const result = await runImage(`image({ type: 'image', data: '${PNG}' });`);
	if (!result.ok) throw new Error(result.error.message);
	expect(result.output).toEqual([{ data: PNG, mimeType: 'image/png', type: 'image' }]);
});

test('image() shows the image block a tool call resolves to', async () => {
	const result = await runImage(`const b = await tools.read({ path: 'a.png' });\nimage(b);`, [
		{ execute: () => ({ data: PNG, mimeType: 'image/png', type: 'image' }), name: 'read' },
	]);
	if (!result.ok) throw new Error(result.error.message);
	expect(result.output).toEqual([{ data: PNG, mimeType: 'image/png', type: 'image' }]);
});

test('image() accepts a data URI with an empty MIME', async () => {
	const result = await runImage(`image('data:;base64,${PNG}');`);
	if (!result.ok) throw new Error(result.error.message);
	expect(result.output).toEqual([{ data: PNG, mimeType: 'image/png', type: 'image' }]);
});

test('image() accepts a data URI with extra parameters', async () => {
	const result = await runImage(`image('data:image/png;charset=utf-8;base64,${PNG}');`);
	if (!result.ok) throw new Error(result.error.message);
	expect(result.output).toEqual([{ data: PNG, mimeType: 'image/png', type: 'image' }]);
});

test('image() accepts an uppercase scheme', async () => {
	const result = await runImage(`image('DATA:image/png;base64,${PNG}');`);
	if (!result.ok) throw new Error(result.error.message);
	expect(result.output).toEqual([{ data: PNG, mimeType: 'image/png', type: 'image' }]);
});

test('image() names the format from the data, not the declared MIME', async () => {
	const result = await runImage(`image('data:image/jpeg;base64,${PNG}');`);
	if (!result.ok) throw new Error(result.error.message);
	expect(result.output).toEqual([{ data: PNG, mimeType: 'image/png', type: 'image' }]);
});

test('image() rejects a remote URL', async () => {
	const result = await runImage("image('https://example.com/a.png');");
	if (result.ok) throw new Error('Expected error result');
	expect(result.error.message).toContain('invalid image output');
});

test('image() rejects data that is not a PNG, JPEG, GIF, or WebP', async () => {
	const result = await runImage("image('data:image/png;base64,AAAA');");
	if (result.ok) throw new Error('Expected error result');
	expect(result.error.message).toContain('The image data is not a PNG, JPEG, GIF, or WebP image');
});

test('image() rejects values that are not images', async () => {
	for (const code of ['image(42);', "image('');", "image({ type: 'text' });"]) {
		const result = await runImage(code);
		if (result.ok) throw new Error(`Expected error result for ${code}`);
		expect(result.error.message).toContain('image expects a base64 data URI');
	}
});

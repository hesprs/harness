import { test, expect } from 'bun:test';
import { Buffer } from 'node:buffer';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { formatSize, listDirectory, numberLines, pdfToMarkdown, readPath } from '@/tools/read.ts';
import { tmpRoot, makePdf } from './utils';

test('readPath returns file content for a text file', async () => {
	const root = tmpRoot();
	try {
		const file = join(root, 'a.txt');
		await Bun.write(file, 'hello harness');
		expect((await readPath(file)).content).toContain('hello harness');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('readPath on a directory lists children with stats', async () => {
	const root = tmpRoot();
	try {
		await Bun.write(join(root, 'one.txt'), 'l1\nl2\nl3\n');
		await Bun.write(join(root, 'blob.bin'), Buffer.from([0, 1, 2]));
		mkdirSync(join(root, 'sub'));
		const listing = (await readPath(root)).content;
		expect(listing).toContain('one.txt: 3 lines, 9B');
		expect(listing).toContain(`blob.bin: ${formatSize(3)}`);
		expect(listing).toContain('sub: folder');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('readPath lists a directory recursively with nested paths', async () => {
	const root = tmpRoot();
	try {
		await Bun.write(join(root, 'top.txt'), 'a\n');
		mkdirSync(join(root, 'sub'));
		await Bun.write(join(root, 'sub', 'deep.txt'), 'b\n');
		const listing = (await readPath(root, { recursive: true })).content;
		expect(listing).toContain('sub: folder');
		expect(listing).toContain('sub/deep.txt: 1 lines, 2B');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('listDirectory filters entries by path pattern', async () => {
	const root = tmpRoot();
	try {
		await Bun.write(join(root, 'keep.ts'), 'a\n');
		await Bun.write(join(root, 'drop.md'), 'a\n');
		const listing = await listDirectory(root, { filter: '\\.ts$' });
		expect(listing).toContain('keep.ts');
		expect(listing).not.toContain('drop.md');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('readPath numbers file lines and honors start/end/filter', async () => {
	const root = tmpRoot();
	try {
		const file = join(root, 'n.txt');
		await Bun.write(file, 'alpha\nbeta\ngamma\ndelta\n');
		expect((await readPath(file)).content).toBe('1 alpha\n2 beta\n3 gamma\n4 delta');
		expect((await readPath(file, { end: 3, start: 2 })).content).toBe('2 beta\n3 gamma');
		expect((await readPath(file, { start: 3 })).content).toBe('3 gamma\n4 delta');
		expect((await readPath(file, { end: 1 })).content).toBe('1 alpha');
		// Filtered lines keep their original numbers.
		expect((await readPath(file, { filter: 'ta$' })).content).toBe('2 beta\n4 delta');
		expect((await readPath(file, { end: 99, start: 4 })).content).toBe('4 delta');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('readPath reports an invalid filter regex as an error', async () => {
	const root = tmpRoot();
	try {
		const file = join(root, 'x.txt');
		await Bun.write(file, 'a\n');
		const result = await readPath(file, { filter: '(' });
		expect(result.isError).toBe(true);
		expect(result.content).toContain('x.txt');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('numberLines handles empty content and clamps ranges', () => {
	expect(numberLines('')).toBe('');
	expect(numberLines('a\nb\n', { end: -5, start: 0 })).toBe('1 a'); // Clamped below 1
	expect(numberLines('a\nb\n', { start: 3 })).toBe(''); // Beyond the last line
});

test('formatSize renders human-readable sizes', () => {
	expect(formatSize(0)).toBe('0B');
	expect(formatSize(512)).toBe('512B');
	expect(formatSize(2048)).toBe('2.0KB');
	expect(formatSize(3 * 1024 * 1024)).toBe('3.0MB');
});

test('readPath extracts a PDF to markdown', async () => {
	const root = tmpRoot();
	try {
		const file = join(root, 'doc.pdf');
		await Bun.write(file, makePdf('Hello PDF Harness'));
		const result = await readPath(file);
		expect(result.content.toLowerCase()).toContain('hello');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('pdfToMarkdown extracts text from a PDF buffer', () => {
	const md = pdfToMarkdown(makePdf('Extracted Text'));
	expect(md.toLowerCase()).toContain('extracted');
});

test('readPath reports missing paths as errors', async () => {
	const result = await readPath('/nonexistent/harness-path');
	expect(result.isError).toBe(true);
});

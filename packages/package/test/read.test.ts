import { formatSize } from '@earendil-works/pi-coding-agent';
import { test, expect } from 'bun:test';
import { Buffer } from 'node:buffer';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { formatListing, pdfToMarkdown, readPath } from '@/tools/read.ts';
import { tmpRoot, makePdf } from './utils';

test('readPath returns raw file content without line numbers', async () => {
	const root = tmpRoot();
	try {
		const file = join(root, 'a.txt');
		await Bun.write(file, 'hello\nworld\n');
		const result = await readPath(file);
		if ('content' in result) expect(result.content).toBe('hello\nworld');
		else throw new Error('Expected content variant');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('readPath on a directory returns structured listing (depth-1)', async () => {
	const root = tmpRoot();
	try {
		await Bun.write(join(root, 'one.txt'), 'l1\nl2\nl3\n');
		await Bun.write(join(root, 'blob.bin'), Buffer.from([0, 1, 2]));
		mkdirSync(join(root, 'sub'));
		await Bun.write(join(root, 'sub', 'deep.txt'), 'b\n');
		const result = await readPath(root);
		if (!('listing' in result)) throw new Error('Expected listing variant');
		expect(result.listing).toContainEqual({
			lineCount: 3,
			name: 'one.txt',
			size: 9,
			type: 'file',
		});
		expect(result.listing).toContainEqual({ name: 'blob.bin', size: 3, type: 'file' });
		expect(result.listing).toContainEqual({ itemCount: 1, name: 'sub', type: 'folder' });
		// Depth-1: nested entries must not appear
		expect(result.listing.find((e) => e.name === 'deep.txt')).toBeUndefined();
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('formatListing renders entries as human-readable text', () => {
	const entries = [
		{ lineCount: 3, name: 'one.txt', size: 9, type: 'file' as const },
		{ name: 'blob.bin', size: 3, type: 'file' as const },
		{ itemCount: 5, name: 'sub', type: 'folder' as const },
	];
	const formatted = formatListing(entries);
	expect(formatted).toContain('one.txt: 3 lines, 9B');
	expect(formatted).toContain(`blob.bin: ${formatSize(3)}`);
	expect(formatted).toContain('sub: folder (5 items)');
});

test('readPath honors offset and limit', async () => {
	const root = tmpRoot();
	try {
		const file = join(root, 'n.txt');
		await Bun.write(file, 'alpha\nbeta\ngamma\ndelta\n');
		let result = await readPath(file, { limit: 2, offset: 2 });
		if ('content' in result)
			expect(result.content).toBe(
				'beta\ngamma\n\n[1 more lines in file. Use offset=4 to continue.]',
			);
		else throw new Error('Expected content variant');
		result = await readPath(file, { offset: 3 });
		if ('content' in result) expect(result.content).toBe('gamma\ndelta');
		else throw new Error('Expected content variant');
		result = await readPath(file, { limit: 4 });
		if ('content' in result) expect(result.content).toBe('alpha\nbeta\ngamma\ndelta');
		else throw new Error('Expected content variant');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('readPath shows continuation hint when limit stops early', async () => {
	const root = tmpRoot();
	try {
		const file = join(root, 'n.txt');
		await Bun.write(file, 'a\nb\nc\nd\ne\n');
		const result = await readPath(file, { limit: 2 });
		if ('content' in result)
			expect(result.content).toBe(
				'a\nb\n\n[3 more lines in file. Use offset=3 to continue.]',
			);
		else throw new Error('Expected content variant');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('readPath shows continuation hint when truncated by line limit', async () => {
	const root = tmpRoot();
	try {
		const file = join(root, 'big.txt');
		await Bun.write(
			file,
			`${Array.from({ length: 2001 }, (_, i) => `line ${i + 1}`).join('\n')}\n`,
		);
		const result = await readPath(file);
		if ('content' in result)
			expect(result.content).toContain(
				'[Showing lines 1-2000 of 2001. Use offset=2001 to continue.]',
			);
		else throw new Error('Expected content variant');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('readPath reports offset beyond file end as error', async () => {
	const root = tmpRoot();
	try {
		const file = join(root, 'small.txt');
		await Bun.write(file, 'only\none\n');
		const result = await readPath(file, { offset: 10 });
		if ('content' in result) {
			expect(result.isError).toBe(true);
			expect(result.content).toContain('beyond end of file');
		} else throw new Error('Expected content variant');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
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
		if ('content' in result) expect(result.content.toLowerCase()).toContain('hello');
		else throw new Error('Expected content variant');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('pdfToMarkdown extracts text from a PDF buffer', () => {
	const md = pdfToMarkdown(makePdf('Extracted Text'));
	expect(md.toLowerCase()).toContain('extracted');
});

test('readPath returns an image payload for a binary image', async () => {
	const root = tmpRoot();
	try {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
		const file = join(root, 'pic.png');
		await Bun.write(file, png);
		const result = await readPath(file);
		if ('image' in result) {
			expect(result.image.mimeType).toBe('image/png');
			expect(result.image.data).toBe(png.toString('base64'));
		} else throw new Error('Expected image variant');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('readPath reports missing paths as errors', async () => {
	const result = await readPath('/nonexistent/harness-path');
	if ('content' in result) expect(result.isError).toBe(true);
	else throw new Error('Expected content variant');
});

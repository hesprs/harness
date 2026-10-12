import { test, expect } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { applyEdits, editFile } from '@/tools/edit.ts';
import { tmpRoot } from './utils';

test('exact match replaces', () => {
	const result = applyEdits('a\nb\nc\n', [{ newText: 'B', oldText: 'b' }]);
	expect(result.failures).toEqual([]);
	expect(result.content).toBe('a\nB\nc\n');
});

test('indentation and whitespace drift still matches real text', () => {
	const result = applyEdits('\tfoo\n\t\tbar   baz\n', [
		{ newText: 'X', oldText: 'foo\n  bar\tbaz' },
	]);
	expect(result.failures).toEqual([]);
	expect(result.content).toBe('X\n');
});

test('blank-line differences are tolerated on both sides', () => {
	const result = applyEdits('a\n\n\nb\n', [{ newText: 'c', oldText: 'a\n\nb' }]);
	expect(result.failures).toEqual([]);
	expect(result.content).toBe('c\n');
});

test('ambiguous oldText is skipped with line numbers', () => {
	const result = applyEdits('x\nx\n', [{ newText: 'y', oldText: 'x' }]);
	expect(result.failures.join('\n')).toContain('matches at lines 1, 2');
	expect(result.content).toBe('x\nx\n'); // Nothing to apply
});

test('replaceAll replaces every occurrence', () => {
	const result = applyEdits('x\nm\nx\n', [{ newText: 'y', oldText: 'x', replaceAll: true }]);
	expect(result.failures).toEqual([]);
	expect(result.content).toBe('y\nm\ny\n');
});

test('replaceAll replaces every occurrence of a fuzzy match', () => {
	const result = applyEdits('\tx\n\ty\nm\n\tx\n\ty\n', [
		{ newText: 'z', oldText: 'x\ny', replaceAll: true },
	]);
	expect(result.failures).toEqual([]);
	expect(result.content).toBe('z\nm\nz\n');
});

test('line-merged and line-split oldText still match whole lines', () => {
	expect(
		applyEdits('const a = 1;\nconst b = 2;\n', [
			{ newText: 'X', oldText: 'const a = 1; const b = 2;' },
		]).content,
	).toBe('X\n');
	expect(applyEdits('foo bar\n', [{ newText: 'X', oldText: 'foo\nbar' }]).content).toBe('X\n');
});

test('a partial-line oldText with inner whitespace drift matches its whole line', () => {
	const result = applyEdits('const x = 1; // note\n', [
		{ newText: 'y', oldText: 'const  x = 1;' },
	]);
	expect(result.failures).toEqual([]);
	expect(result.content).toBe('y\n');
});

test('a whitespace-only oldText is skipped explicitly', () => {
	const result = applyEdits('a\n', [{ newText: 'y', oldText: ' \n\t ' }]);
	expect(result.failures.join('\n')).toContain('whitespace');
});

test('multiple edits match the original content, not incrementally', () => {
	const result = applyEdits('a\nb\nc\n', [
		{ newText: 'B', oldText: 'b' },
		{ newText: 'C', oldText: 'c' },
	]);
	expect(result.failures).toEqual([]);
	expect(result.content).toBe('a\nB\nC\n');
});

test('overlapping edits keep the first and skip the clash', () => {
	const result = applyEdits('a\nb\nc\n', [
		{ newText: 'X', oldText: 'a\nb' },
		{ newText: 'Y', oldText: 'b\nc' },
	]);
	expect(result.failures.join('\n')).toContain('overlap');
	expect(result.applied).toEqual([0]);
	expect(result.content).toBe('X\nc\n');
});

test('an edit identical to its match is skipped as a no-op', () => {
	const result = applyEdits('a\n', [{ newText: 'a', oldText: 'a' }]);
	expect(result.failures.join('\n')).toContain('no change');
});

test('no match reports the tried passes', () => {
	const result = applyEdits('a\n', [{ newText: 'z', oldText: 'missing' }]);
	expect(result.failures.join('\n')).toContain('not found');
	expect(result.failures.join('\n')).toContain('agnostic');
});

test('a bad edit is skipped while the rest still apply', () => {
	const result = applyEdits('a\nb\n', [
		{ newText: 'B', oldText: 'b' },
		{ newText: 'z', oldText: 'missing' },
	]);
	expect(result.failures).toEqual([
		'edits[1]: oldText not found: no exact or whitespace/escape-agnostic match',
	]);
	expect(result.applied).toEqual([0]);
	expect(result.content).toBe('a\nB\n');
});

test('editFile writes the change and round-trips CRLF endings', async () => {
	const root = tmpRoot();
	try {
		const file = join(root, 'crlf.txt');
		await Bun.write(file, 'a\r\nb\r\nc\r\n');
		expect((await editFile(file, [{ newText: 'a\nB', oldText: 'a\nb' }])).failures).toEqual([]);
		expect(await Bun.file(file).text()).toBe('a\r\nB\r\nc\r\n');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('editFile preserves a BOM and skips it for matching', async () => {
	const root = tmpRoot();
	try {
		const file = join(root, 'bom.txt');
		await Bun.write(file, '\uFEFFa\nb\n');
		expect((await editFile(file, [{ newText: 'B', oldText: 'b' }])).failures).toEqual([]);
		// Reading with .text() would strip the BOM — decode with it kept.
		const written = new TextDecoder('utf-8', { ignoreBOM: true }).decode(
			await Bun.file(file).bytes(),
		);
		expect(written).toBe('\uFEFFa\nB\n');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('editFile writes the matching edits and skips the rest', async () => {
	const root = tmpRoot();
	try {
		const file = join(root, 'partial.txt');
		await Bun.write(file, 'a\nb\nc\n');
		const outcome = await editFile(file, [
			{ newText: 'A', oldText: 'a' },
			{ newText: 'z', oldText: 'missing' },
		]);
		expect(outcome.applied).toEqual([0]);
		expect(outcome.failures.join('\n')).toContain('edits[1]');
		expect(await Bun.file(file).text()).toBe('A\nb\nc\n');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('editFile leaves the file untouched when no edit matches', async () => {
	const root = tmpRoot();
	try {
		const file = join(root, 'keep.txt');
		await Bun.write(file, 'x\nx\n');
		const outcome = await editFile(file, [{ newText: 'y', oldText: 'x' }]);
		expect(outcome.failures.join('\n')).toContain('ambiguous');
		expect(await Bun.file(file).text()).toBe('x\nx\n');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('editFile rejects on a missing file', async () => {
	const root = tmpRoot();
	try {
		let threw = false;
		try {
			await editFile(join(root, 'nope.txt'), [{ newText: 'y', oldText: 'x' }]);
		} catch {
			threw = true;
		}
		expect(threw).toBeTrue();
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('successful edits produce a renderable diff', () => {
	const result = applyEdits('a\nb\nc\n', [{ newText: 'B', oldText: 'b' }]);
	expect(result.diff).toBe(' 1 a\n-2 b\n+2 B\n 3 c');
});

test('the diff elides distant context with ellipses', () => {
	// Eight visible lines (single-digit numbering); the edit sits far from The start, so the leading gap is elided.
	const content = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8'].join('\n');
	const result = applyEdits(content, [{ newText: 'X', oldText: 'l6' }]);
	expect(result.diff).toBe(
		['   ...', ' 2 l2', ' 3 l3', ' 4 l4', ' 5 l5', '-6 l6', '+6 X', ' 7 l7', ' 8 l8'].join(
			'\n',
		),
	);
});

test('the diff numbers multiple hunks with shifted line numbers', () => {
	const result = applyEdits('a\nb\nc\nd\n', [
		{ newText: 'B\nB2', oldText: 'b' },
		{ newText: 'D', oldText: 'd' },
	]);
	expect(result.diff).toBe(' 1 a\n-2 b\n+2 B\n+3 B2\n 3 c\n-4 d\n+5 D');
});

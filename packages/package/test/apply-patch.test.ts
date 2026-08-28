import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPatch } from '@/tools/apply-patch.ts';

function tmpRoot(): string {
	return mkdtempSync(join(tmpdir(), 'harness-patch-'));
}

test('Add File creates a new file with the given content', async () => {
	const root = tmpRoot();
	try {
		await applyPatch(
			root,
			`*** Begin Patch\n*** Add File: new.txt\n+hello\n+world\n*** End Patch`,
		);
		expect(await Bun.file(join(root, 'new.txt')).text()).toBe('hello\nworld\n');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('Update File replaces matched context lines', async () => {
	const root = tmpRoot();
	try {
		await Bun.write(join(root, 'a.txt'), 'one\ntwo\nthree\n');
		await applyPatch(
			root,
			`*** Begin Patch\n*** Update File: a.txt\n@@\n one\n-two\n+TWO\n three\n*** End Patch`,
		);
		expect(await Bun.file(join(root, 'a.txt')).text()).toBe('one\nTWO\nthree\n');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('Update File without context appends when file is missing lines', async () => {
	const root = tmpRoot();
	try {
		await Bun.write(join(root, 'a.txt'), 'start\n');
		await applyPatch(
			root,
			`*** Begin Patch\n*** Update File: a.txt\n@@\n start\n+added\n*** End Patch`,
		);
		expect(await Bun.file(join(root, 'a.txt')).text()).toBe('start\nadded\n');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('Delete File removes the file', async () => {
	const root = tmpRoot();
	try {
		await Bun.write(join(root, 'gone.txt'), 'x\n');
		await applyPatch(root, `*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch`);
		expect(existsSync(join(root, 'gone.txt'))).toBe(false);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('Move to renames the file inside an Update block', async () => {
	const root = tmpRoot();
	try {
		await Bun.write(join(root, 'old.txt'), 'data\n');
		await applyPatch(
			root,
			`*** Begin Patch\n*** Update File: old.txt\n*** Move to: renamed.txt\n@@\n data\n+more\n*** End Patch`,
		);
		expect(existsSync(join(root, 'old.txt'))).toBe(false);
		expect(await Bun.file(join(root, 'renamed.txt')).text()).toBe('data\nmore\n');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('a malformed patch throws', async () => {
	const root = tmpRoot();
	try {
		// oxlint-disable-next-line typescript/await-thenable
		await expect(applyPatch(root, 'not a patch')).rejects.toThrow();
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('updating a nonexistent file throws', async () => {
	const root = tmpRoot();
	try {
		// oxlint-disable-next-line typescript/await-thenable
		await expect(
			applyPatch(root, `*** Begin Patch\n*** Update File: nope.txt\n@@\n+x\n*** End Patch`),
		).rejects.toThrow();
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('the summary lists applied changes', async () => {
	const root = tmpRoot();
	try {
		const result = await applyPatch(
			root,
			`*** Begin Patch\n*** Add File: x.txt\n+X\n*** End Patch`,
		);
		expect(result.summary).toContain('x.txt');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

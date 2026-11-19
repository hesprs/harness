import { applyPatch, ApplyPatchError } from '@/tools/file/apply-patch.ts';
import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('chunks apply in any order', async () => {
	const root = tmpRoot();
	try {
		await Bun.write(join(root, 'a.txt'), 'one\ntwo\nthree\n');
		await applyPatch(
			root,
			`*** Begin Patch\n*** Update File: a.txt\n@@\n-three\n+THREE\n@@\n-one\n+ONE\n*** End Patch`,
		);
		expect(await Bun.file(join(root, 'a.txt')).text()).toBe('ONE\ntwo\nTHREE\n');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('identical chunks each claim their own occurrence', async () => {
	const root = tmpRoot();
	try {
		await Bun.write(join(root, 'dup.txt'), 'x\ny\nx\n');
		await applyPatch(
			root,
			`*** Begin Patch\n*** Update File: dup.txt\n@@\n-x\n+first\n@@\n-x\n+second\n*** End Patch`,
		);
		expect(await Bun.file(join(root, 'dup.txt')).text()).toBe('first\ny\nsecond\n');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('applicable hunks are applied before the aggregate error names both sides', async () => {
	const root = tmpRoot();
	try {
		await Bun.write(join(root, 'stale.txt'), 'actual\n');
		let thrown: unknown;
		await applyPatch(
			root,
			[
				'*** Begin Patch',
				'*** Update File: stale.txt',
				'@@',
				'-nowhere',
				'+new',
				'*** Add File: fresh.txt',
				'+fresh',
				'*** End Patch',
			].join('\n'),
		).catch((error: unknown) => {
			thrown = error;
		});
		expect(thrown).toBeInstanceOf(ApplyPatchError);
		const error = thrown as ApplyPatchError;
		expect(error.message).toContain('1 of 2 file actions failed.');
		expect(error.message).toContain(
			'- stale.txt (update): Failed to find expected lines in stale.txt:',
		);
		expect(error.message).toContain('Recovery: MUST read stale.txt before retrying.');
		expect(error.message).toContain('Applied:');
		expect(error.message).toContain('- add: fresh.txt');
		expect(error.message).toContain(
			'Recovery: MUST NOT reread other files from this patch unless a specific dependency requires it.',
		);
		expect(error.appliedSummaries).toEqual(['add: fresh.txt']);
		expect(error.failures[0]?.code).toBeUndefined();
		expect(error.failures[0]?.filePath).toBe('stale.txt');
		expect(await Bun.file(join(root, 'fresh.txt')).text()).toBe('fresh\n');
		expect(await Bun.file(join(root, 'stale.txt')).text()).toBe('actual\n');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('a filesystem failure is reported without a reread instruction', async () => {
	const root = tmpRoot();
	try {
		let thrown: unknown;
		await applyPatch(
			root,
			`*** Begin Patch\n*** Update File: missing.txt\n@@\n+x\n*** End Patch`,
		).catch((error: unknown) => {
			thrown = error;
		});
		expect(thrown).toBeInstanceOf(ApplyPatchError);
		const error = thrown as ApplyPatchError;
		expect(error.message).toContain('1 of 1 file actions failed.');
		expect(error.message).toContain('- missing.txt (update):');
		expect(error.message).not.toContain('Recovery: MUST read');
		expect(error.failures[0]?.code).toBe('ENOENT');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('a file whose update has a failing chunk is not written at all', async () => {
	const root = tmpRoot();
	try {
		await Bun.write(join(root, 'a.txt'), 'one\ntwo\n');
		// oxlint-disable-next-line typescript/await-thenable
		await expect(
			applyPatch(
				root,
				`*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+ONE\n@@\n-nowhere\n+X\n*** End Patch`,
			),
		).rejects.toThrow();
		expect(await Bun.file(join(root, 'a.txt')).text()).toBe('one\ntwo\n');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

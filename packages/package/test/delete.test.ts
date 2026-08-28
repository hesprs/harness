import { test, expect } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { deletePath } from '@/tools/delete';
import { tmpRoot } from './utils';

test('plain file deletion removes the file', async () => {
	const root = tmpRoot();
	try {
		const file = join(root, 'note.txt');
		await Bun.write(file, 'x');
		const msg = await deletePath(file);
		expect(msg).toContain('deleted');
		expect(existsSync(file)).toBe(false);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

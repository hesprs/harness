import type { Extension } from '@repo/shared/contract';
/** Delete tool: removes a file. The harness watches session record and topic files on its own and reacts to their deletion — this tool knows nothing about sessions. */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { errText, text } from '@repo/shared/text';
import { unlink } from 'node:fs/promises';
import { Type } from 'typebox';
import { registerActive } from './common.ts';

export async function deletePath(path: string): Promise<string> {
	if (!(await Bun.file(path).exists())) throw new Error(`file not found: ${path}`);
	await unlink(path);
	return `File ${path} deleted`;
}

// Extension that registers the `delete` tool.
export const toolDelete: Extension = (pi) => {
	registerActive(
		pi,
		defineTool({
			description: 'Delete a file or folder.',
			async execute(_toolCallId, params) {
				try {
					await deletePath(params.path);
					return {
						...text(`File ${params.path} deleted`),
						structuredContent: params.path,
					};
				} catch (error) {
					return text(errText(error), true);
				}
			},
			label: 'Delete',
			name: 'delete',
			outputSchema: Type.String({ description: 'The deleted file path' }),
			parameters: Type.Object({ path: Type.String({ description: 'File path to delete' }) }),
		}),
	);
};

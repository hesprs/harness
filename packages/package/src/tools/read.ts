/** Read tool: raw file content with offset/limit pagination and Pi-style continuation hints; depth-1 directory listing as structured entries; PDF → markdown extraction; binary images as base64 image blocks. */
import type { Extension } from '@repo/shared/contract';
import { defineTool, formatSize, truncateHead } from '@earendil-works/pi-coding-agent';
import { extractPagesMarkdown } from '@firecrawl/pdf-inspector';
import { text } from '@repo/shared/text';
import { Buffer } from 'node:buffer';
import { readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { Type } from 'typebox';
import { registerActive } from './common.ts';

/** One directory entry: a file (with byte size and optional line cnt for text files) or a folder (with direct child count). */
export type DirEntry =
	| { type: 'file'; name: string; size: number; lineCount?: number }
	| { type: 'folder'; name: string; itemCount: number };

export type ReadResult =
	| { content: string; isError?: boolean }
	| { image: { data: string; mimeType: string } }
	| { listing: Array<DirEntry> };

export type ReadOptions = {
	/** Line number to start reading from, 1-indexed (files only). */
	offset?: number;
	/** Maximum number of lines to read (files only). */
	limit?: number;
};

/** Extract a PDF buffer to markdown (all pages). */
export function pdfToMarkdown(buffer: Buffer): string {
	return extractPagesMarkdown(buffer)
		.pages.map((page) => page.markdown)
		.join('\n\n');
}

/** Binary image file extensions → MIME types (returned as base64 image blocks). */
const IMAGE_MIME: Record<string, string> = {
	'.bmp': 'image/bmp',
	'.gif': 'image/gif',
	'.jpeg': 'image/jpeg',
	'.jpg': 'image/jpeg',
	'.png': 'image/png',
	'.webp': 'image/webp',
};

/** Describe a single file as a `DirEntry` (reads bytes to determine text line count; binary files omit `lineCount`). */
async function describeFile(absolute: string, name: string): Promise<DirEntry> {
	const bytes = await Bun.file(absolute).bytes();
	let lineCount: number | undefined;
	if (!bytes.includes(0))
		try {
			const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
			lineCount = decoded === '' ? 0 : decoded.replace(/\n$/u, '').split('\n').length;
		} catch {
			lineCount = undefined;
		}
	return lineCount === undefined
		? { name, size: bytes.length, type: 'file' }
		: { lineCount, name, size: bytes.length, type: 'file' };
}

/** Depth-1 directory listing: every direct child as a structured `DirEntry`. */
export async function listDirectory(path: string): Promise<Array<DirEntry>> {
	const entries: Array<DirEntry> = [];
	for (const entry of readdirSync(path, { withFileTypes: true }))
		if (entry.isDirectory())
			entries.push({
				itemCount: readdirSync(join(path, entry.name)).length,
				name: entry.name,
				type: 'folder',
			});
		else entries.push(await describeFile(join(path, entry.name), entry.name));
	return entries;
}

/** Format directory entries as human-readable text: `name: N lines, SIZE`, `name: SIZE`, or `name: folder (N items)`. */
export function formatListing(entries: Array<DirEntry>): string {
	return entries
		.map((entry) => {
			if (entry.type === 'folder') return `${entry.name}: folder (${entry.itemCount} items)`;
			if (entry.lineCount !== undefined)
				return `${entry.name}: ${entry.lineCount} lines, ${formatSize(entry.size)}`;
			return `${entry.name}: ${formatSize(entry.size)}`;
		})
		.join('\n');
}

/** Slice raw text by offset/limit, apply truncation, and append Pi-style continuation hints. */
function paginate(content: string, options: ReadOptions = {}): string {
	if (content === '') return '';
	const lines = content.replace(/\n$/u, '').split('\n');
	const totalLines = lines.length;
	const startLine = options.offset ? Math.max(0, options.offset - 1) : 0;
	if (startLine >= totalLines)
		throw new Error(
			`Offset ${options.offset} is beyond end of file (${totalLines} lines total)`,
		);
	const startDisplay = startLine + 1;
	let selected: string;
	let userLimit: number | undefined;
	if (options.limit === undefined) selected = lines.slice(startLine).join('\n');
	else {
		const endLine = Math.min(startLine + options.limit, totalLines);
		selected = lines.slice(startLine, endLine).join('\n');
		userLimit = endLine - startLine;
	}
	const trunc = truncateHead(selected);
	if (trunc.firstLineExceedsLimit)
		return `[Line ${startDisplay} is ${formatSize(Buffer.byteLength(lines[startLine] ?? '', 'utf8'))}, exceeds ${formatSize(trunc.maxBytes)} limit.]`;
	let output = trunc.content;
	if (trunc.truncated) {
		const endDisplay = startDisplay + trunc.outputLines - 1;
		const limitNote =
			trunc.truncatedBy === 'bytes' ? ` (${formatSize(trunc.maxBytes)} limit)` : '';
		output += `\n\n[Showing lines ${startDisplay}-${endDisplay} of ${totalLines}${limitNote}. Use offset=${endDisplay + 1} to continue.]`;
	} else if (userLimit !== undefined && startLine + userLimit < totalLines) {
		const remaining = totalLines - (startLine + userLimit);
		output += `\n\n[${remaining} more lines in file. Use offset=${startLine + userLimit + 1} to continue.]`;
	}
	return output;
}

/** Read a file (raw content with offset/limit pagination; PDFs are extracted to markdown first; binary images become base64 image blocks) or a directory (depth-1 structured listing). */
export async function readPath(path: string, options: ReadOptions = {}): Promise<ReadResult> {
	let isDirectory: boolean;
	try {
		isDirectory = statSync(path).isDirectory();
	} catch {
		return { content: `File not found: ${path}`, isError: true };
	}
	try {
		if (isDirectory) return { listing: await listDirectory(path) };
		const ext = extname(path).toLowerCase();
		if (ext in IMAGE_MIME) {
			const mimeType = IMAGE_MIME[ext] as string;
			return {
				image: {
					data: Buffer.from(await Bun.file(path).arrayBuffer()).toString('base64'),
					mimeType,
				},
			};
		}
		const raw =
			ext === '.pdf'
				? pdfToMarkdown(Buffer.from(await Bun.file(path).arrayBuffer()))
				: await Bun.file(path).text();
		return { content: paginate(raw, options) };
	} catch (error) {
		return {
			content: `${path}: ${error instanceof Error ? error.message : String(error)}`,
			isError: true,
		};
	}
}

// Extension that registers the `read` tool.
const dirEntrySchema = Type.Union([
	Type.Object({
		lineCount: Type.Optional(Type.Number()),
		name: Type.String(),
		size: Type.Number(),
		type: Type.Literal('file'),
	}),
	Type.Object({
		itemCount: Type.Number(),
		name: Type.String(),
		type: Type.Literal('folder'),
	}),
]);

const readOutputSchema = Type.Union([
	Type.Object({ content: Type.String(), isError: Type.Optional(Type.Boolean()) }),
	Type.Object({ image: Type.Object({ data: Type.String(), mimeType: Type.String() }) }),
	Type.Object({ listing: Type.Array(dirEntrySchema) }),
]);

export const toolRead: Extension = (pi) => {
	registerActive(
		pi,
		defineTool({
			description:
				'Read a file or a directory. Can read images; PDFs are extracted to markdown; reading directories lists contents. Use this and NEVER use Bash to read files or list directories.',
			async execute(_toolCallId, params) {
				const result = await readPath(params.path, {
					limit: params.limit,
					offset: params.offset,
				});
				if ('image' in result)
					return {
						content: [
							{
								text: `Read image file [${result.image.mimeType}]`,
								type: 'text',
							} as const,
							{
								data: result.image.data,
								mimeType: result.image.mimeType,
								type: 'image',
							} as const,
						],
						details: undefined,
						structuredContent: result,
					};
				if ('listing' in result)
					return { ...text(formatListing(result.listing)), structuredContent: result };
				return {
					...text(result.content, result.isError === true),
					structuredContent: result,
				};
			},
			label: 'Read',
			name: 'read',
			outputSchema: readOutputSchema,
			parameters: Type.Object({
				limit: Type.Optional(
					Type.Number({
						description: 'Maximum number of lines to read (files only)',
					}),
				),
				offset: Type.Optional(
					Type.Number({
						description: 'Line number to start reading from, 1-indexed (files only)',
					}),
				),
				path: Type.String({ description: 'File or directory path' }),
			}),
		}),
	);
};

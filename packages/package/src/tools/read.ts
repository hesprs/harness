import type { Extension } from '@repo/shared/contract';
import { defineTool } from '@earendil-works/pi-coding-agent';
/**
 * Read tool implementation: numbered file content with line range and
 * regex filtering, directory listing (line count, size, or `folder`,
 * optionally recursive), PDF → markdown extraction, binary images as
 * base64 image blocks.
 */
import { extractPagesMarkdown } from '@firecrawl/pdf-inspector';
import { text } from '@repo/shared/text';
import { Buffer } from 'node:buffer';
import { readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { Type } from 'typebox';
import { registerActive } from './common.ts';

export type ReadResult = {
	content: string;
	/** Base64 image payload when the path is a binary image file. */
	image?: { data: string; mimeType: string };
	isError?: boolean;
};

export type ReadOptions = {
	/** First line to show, 1-based inclusive (files only). */
	end?: number;
	/** Regex pattern; only matching lines (files) or paths (directories) are shown. */
	filter?: string;
	/** List directory contents recursively (directories only). */
	recursive?: boolean;
	/** Last line to show, 1-based inclusive (files only). */
	start?: number;
};

export type ListOptions = Pick<ReadOptions, 'filter' | 'recursive'>;

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

const compileFilter = (pattern: string | undefined): RegExp | undefined =>
	pattern === undefined ? undefined : new RegExp(pattern, 'u');

/** Human-readable byte size, e.g. `913B`, `3.5KB`, `1.2MB`. */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** One directory entry: `path: folder`, `path: N lines, SIZE`, or `path: SIZE` (binary). */
async function describeFile(absolute: string, shown: string): Promise<string> {
	const bytes = await Bun.file(absolute).bytes();
	let decoded: string | undefined;
	if (!bytes.includes(0))
		try {
			decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		} catch {
			decoded = undefined;
		}

	const size = formatSize(bytes.length);
	if (decoded === undefined) return `${shown}: ${size}`;
	const count = decoded === '' ? 0 : decoded.replace(/\n$/u, '').split('\n').length;
	return `${shown}: ${count} lines, ${size}`;
}

/** Directory listing: every child with its line count (when countable), size,
 * or `folder` marker; nested paths when `recursive`. */
export async function listDirectory(path: string, options: ListOptions = {}): Promise<string> {
	const filter = compileFilter(options.filter);
	const keep = (shown: string): boolean => filter === undefined || filter.test(shown);
	const lines: Array<string> = [];
	const walk = async (dir: string, prefix: string): Promise<void> => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const shown = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) {
				if (keep(shown)) lines.push(`${shown}: folder`);
				if (options.recursive === true) await walk(join(dir, entry.name), shown);
			} else if (keep(shown)) lines.push(await describeFile(join(dir, entry.name), shown));
		}
	};
	await walk(path, '');
	return lines.join('\n');
}

/** Number each line (`N line`, original numbering); `start`/`end` select a
 * 1-based inclusive range and `filter` keeps only matching lines. */
export function numberLines(content: string, options: ReadOptions = {}): string {
	if (content === '') return '';
	const lines = content.replace(/\n$/u, '').split('\n');
	const filter = compileFilter(options.filter);
	const out: Array<string> = [];
	const start = Math.max(1, options.start ?? 1);
	const end = Math.min(lines.length, Math.max(1, options.end ?? lines.length));
	for (let i = start; i <= end; i++) {
		const line = lines[i - 1] ?? '';
		if (filter === undefined || filter.test(line)) out.push(`${i} ${line}`);
	}
	return out.join('\n');
}

/** Read a file (numbered, ranged, filtered; PDFs are extracted to markdown
 * first; binary images become base64 image blocks) or a directory (see
 * listDirectory). */
export async function readPath(path: string, options: ReadOptions = {}): Promise<ReadResult> {
	let isDirectory: boolean;
	try {
		isDirectory = statSync(path).isDirectory();
	} catch {
		return { content: `File not found: ${path}`, isError: true };
	}
	try {
		if (isDirectory) return { content: await listDirectory(path, options) };
		const ext = extname(path).toLowerCase();
		if (ext in IMAGE_MIME) {
			const mimeType = IMAGE_MIME[ext] as string;
			return {
				content: `Read image file [${mimeType}]`,
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
		return { content: numberLines(raw, options) };
	} catch (error) {
		return {
			content: `${path}: ${error instanceof Error ? error.message : String(error)}`,
			isError: true,
		};
	}
}

// Extension that registers the `read` tool.
export const toolRead: Extension = (pi) => {
	registerActive(
		pi,
		defineTool({
			description:
				'Read a file or a directory. Can read images; PDFs are extracted to markdown; reading directories lists files. Use this and NEVER use Bash to read files or list directories.',
			async execute(_toolCallId, params) {
				const result = await readPath(params.path, {
					end: params.end,
					filter: params.filter,
					recursive: params.recursive,
					start: params.start,
				});
				if (result.image)
					return {
						content: [
							{ text: result.content, type: 'text' } as const,
							{
								data: result.image.data,
								mimeType: result.image.mimeType,
								type: 'image',
							} as const,
						],
						details: undefined,
					};
				return text(result.content, result.isError === true);
			},
			label: 'Read',
			name: 'read',
			parameters: Type.Object({
				end: Type.Optional(
					Type.Number({
						description: 'Last line to show, 1-based inclusive (files only)',
					}),
				),
				filter: Type.Optional(
					Type.String({
						description:
							'Regex pattern; only matching lines (files) or paths (directories) are shown',
					}),
				),
				path: Type.String({ description: 'File or directory path' }),
				recursive: Type.Optional(
					Type.Boolean({
						description: 'List directory contents recursively (directories only)',
					}),
				),
				start: Type.Optional(
					Type.Number({
						description: 'First line to show, 1-based inclusive (files only)',
					}),
				),
			}),
		}),
	);
};

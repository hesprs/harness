import type { Extension } from '@repo/shared/contract';
/**
 * Fetch tool: single-URL GET, `extract` (HTML→markdown, PDF→markdown) or
 * `raw` output, optional query params, optional save to a temp file.
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { errText, text } from '@repo/shared/text';
import { Defuddle } from 'defuddle/node';
import { Buffer } from 'node:buffer';
import { Type } from 'typebox';
import { registerActive } from './common.ts';
import { pdfToMarkdown } from './read.ts';

export type FetchOptions = {
	url: string;
	format?: 'extract' | 'raw';
	params?: Record<string, string>;
	/** Save the output (extracted or raw) to a temp file and return its path. */
	saveToTemp?: boolean;
};

/** HTML → markdown via `defuddle/node` (accepts raw HTML string). */
export async function extractHtml(html: string, url: string): Promise<string> {
	const result = await Defuddle(html, url, { markdown: true });
	return result.contentMarkdown ?? result.content;
}

/** Common MIME types → file extensions. */
const MIME_EXTENSIONS: Record<string, string> = {
	'application/gzip': 'gz',
	'application/javascript': 'js',
	'application/json': 'json',
	'application/pdf': 'pdf',
	'application/x-tar': 'tar',
	'application/xml': 'xml',
	'application/zip': 'zip',
	'image/gif': 'gif',
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/svg+xml': 'svg',
	'image/webp': 'webp',
	'text/css': 'css',
	'text/html': 'html',
	'text/javascript': 'js',
	'text/plain': 'txt',
	'text/xml': 'xml',
};

/** Magic-byte prefixes → file extensions. */
const MAGIC_EXTENSIONS: Array<[string, string]> = [
	['25504446', 'pdf'], // %PDF
	['89504e47', 'png'],
	['ffd8ff', 'jpg'],
	['47494638', 'gif'], // GIF8
	['1f8b', 'gz'],
	['504b0304', 'zip'],
];

/** Best-effort file extension for the saved data. */
function tempExtension(data: string | Uint8Array, url?: URL, contentType?: string): string {
	if (typeof data === 'string') return '.md'; // Extracted output is markdown
	if (
		data.length >= 12 &&
		data[8] === 0x57 &&
		data[9] === 0x45 &&
		data[10] === 0x42 &&
		data[11] === 0x50
	)
		return '.webp'; // RIFF....WEBP
	const hex = Buffer.from(data.slice(0, 4)).toString('hex');
	const mime = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
	const fromUrl =
		url === undefined
			? undefined
			: /\.(?<ext>[a-z0-9]{1,5})$/iu.exec(url.pathname)?.groups?.ext?.toLowerCase();
	return `.${MIME_EXTENSIONS[mime] ?? fromUrl ?? MAGIC_EXTENSIONS.find(([magic]) => hex.startsWith(magic))?.[1] ?? 'bin'}`;
}

/** Save `data` to a temp file and return its path. */
async function saveTemp(data: string | Uint8Array, ext: string): Promise<string> {
	const path = `${process.env.TMPDIR ?? '/tmp'}/fetch-${crypto.randomUUID()}${ext}`;
	await Bun.write(path, data);
	return path;
}

export async function fetchUrl(opts: FetchOptions): Promise<string> {
	const url = new URL(opts.url);
	for (const [key, value] of Object.entries(opts.params ?? {})) url.searchParams.set(key, value);

	const response = await fetch(url);
	if (!response.ok) throw new Error(`fetch failed: ${response.status} ${response.statusText}`);

	if (opts.format === 'raw') {
		// Raw + save preserves the exact byte stream (binary included).
		if (opts.saveToTemp) {
			const bytes = new Uint8Array(await response.arrayBuffer());
			return saveTemp(
				bytes,
				tempExtension(bytes, url, response.headers.get('content-type') ?? undefined),
			);
		}
		return response.text();
	}
	const contentType = response.headers.get('content-type') ?? '';
	let out: string;
	if (contentType.includes('pdf') || url.pathname.endsWith('.pdf'))
		out = pdfToMarkdown(Buffer.from(await response.arrayBuffer()));
	else if (contentType.includes('html') || contentType.includes('xml'))
		out = await extractHtml(await response.text(), url.toString());
	else out = await response.text();
	return opts.saveToTemp ? saveTemp(out, tempExtension(out)) : out;
}

// Extension that registers the `fetch` tool.
export const toolFetch: Extension = (pi) => {
	const formats = Type.Union([Type.Literal('extract'), Type.Literal('raw')]);
	const stringRecord = Type.Record(Type.String(), Type.String());
	registerActive(
		pi,
		defineTool({
			description:
				'Fetch a single URL with GET. Output format `extract` (default; HTML and PDF to markdown) or `raw`. Optional query params and save-to-temp-file (saves the output, extracted or raw.',
			async execute(_toolCallId, params, signal) {
				try {
					const out = await fetchUrl(params);
					return signal?.aborted ? text('aborted', true) : text(out);
				} catch (error) {
					return text(errText(error), true);
				}
			},
			label: 'Fetch',
			name: 'fetch',
			parameters: Type.Object({
				format: Type.Optional(formats),
				params: Type.Optional(stringRecord),
				saveToTemp: Type.Optional(Type.Boolean()),
				url: Type.String({ description: 'URL to fetch' }),
			}),
		}),
	);
};

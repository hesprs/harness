import type { Extension } from '@repo/shared/contract';
/**
 * Fetch tool: single-URL GET. Output format `extract` (HTML and PDF →
 * markdown; the default for HTML and PDF responses) or `raw` (the default
 * for everything else — an explicit `extract` on other types is ignored).
 * Binary images always become base64 image blocks; optional query params
 * and save to a temp file.
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
	/** Output format. Defaults to `extract` for HTML and PDF responses, `raw`
	 * for everything else; an explicit `extract` on other types is ignored. */
	format?: 'extract' | 'raw';
	params?: Record<string, string>;
	/** Save the output (extracted markdown or raw bytes) to a temp file and return its path. */
	saveToTemp?: boolean;
};

/** HTML → markdown via `defuddle/node` (accepts raw HTML string). */
export async function extractHtml(html: string, url: string): Promise<string> {
	const result = await Defuddle(html, url, { markdown: true });
	return result.contentMarkdown ?? result.content;
}

/** Binary image MIME types → returned as base64 image blocks (SVG is text). */
const IMAGE_MIME = new Set(['image/bmp', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']);

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

/** Best-effort file extension for saved raw bytes. */
function tempExtension(data: Uint8Array, url?: URL, contentType?: string): string {
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

export type FetchResult = {
	content: string;
	/** Base64 image payload when the response is a binary image. */
	image?: { data: string; mimeType: string };
	isError?: boolean;
};

/** Fetch one URL. `format` defaults to `extract` for HTML and PDF responses
 * and `raw` otherwise; an explicit `extract` on any other type is ignored
 * (raw). `extract` output is markdown (HTML and PDF only); `raw` returns the
 * response body as-is. Binary images (bmp/gif/jpeg/png/webp) always become
 * base64 image attachments regardless of format. `saveToTemp` writes the
 * output to a temp file and returns its path — `.md` for extracted output,
 * otherwise the raw bytes with an extension derived from the content type
 * (URL path and magic bytes as fallbacks). */
export async function fetchUrl(opts: FetchOptions): Promise<FetchResult> {
	const url = new URL(opts.url);
	for (const [key, value] of Object.entries(opts.params ?? {})) url.searchParams.set(key, value);

	const response = await fetch(url);
	if (!response.ok) throw new Error(`fetch failed: ${response.status} ${response.statusText}`);

	const contentType = response.headers.get('content-type') ?? '';
	const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';

	// Binary images become base64 image blocks (or saved bytes), never text.
	if (IMAGE_MIME.has(mime)) {
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (opts.saveToTemp)
			return { content: await saveTemp(bytes, tempExtension(bytes, url, contentType)) };
		return {
			content: `Fetched image [${mime}]`,
			image: { data: Buffer.from(bytes).toString('base64'), mimeType: mime },
		};
	}

	// `extract` only applies to HTML and PDF responses; everything else is raw.
	const extract =
		opts.format !== 'raw' &&
		(mime.includes('pdf') || mime.includes('html') || url.pathname.endsWith('.pdf'));
	if (extract) {
		const out =
			mime.includes('pdf') || url.pathname.endsWith('.pdf')
				? pdfToMarkdown(Buffer.from(await response.arrayBuffer()))
				: await extractHtml(await response.text(), url.toString());
		return { content: opts.saveToTemp ? await saveTemp(out, '.md') : out };
	}
	// Raw: save preserves the exact byte stream (binary included).
	if (opts.saveToTemp) {
		const bytes = new Uint8Array(await response.arrayBuffer());
		return { content: await saveTemp(bytes, tempExtension(bytes, url, contentType)) };
	}
	return { content: await response.text() };
}

// Extension that registers the `fetch` tool.
export const toolFetch: Extension = (pi) => {
	const formats = Type.Union([Type.Literal('extract'), Type.Literal('raw')], {
		description:
			'Output format. `extract`: to markdown; default for HTML and PDF, ignored on other types. `raw`: response body as-is.',
	});
	const stringRecord = Type.Record(Type.String(), Type.String(), {
		description: 'Optional query params set on the URL.',
	});
	registerActive(
		pi,
		defineTool({
			description: 'Fetch a single URL with GET. Can fetch images.',
			async execute(_toolCallId, params, signal) {
				try {
					const out = await fetchUrl(params);
					if (signal?.aborted) return text('aborted', true);
					if (out.image)
						return {
							content: [
								{ text: out.content, type: 'text' } as const,
								{
									data: out.image.data,
									mimeType: out.image.mimeType,
									type: 'image',
								} as const,
							],
							details: undefined,
						};
					return text(out.content);
				} catch (error) {
					return text(errText(error), true);
				}
			},
			label: 'Fetch',
			name: 'fetch',
			parameters: Type.Object({
				format: Type.Optional(formats),
				params: Type.Optional(stringRecord),
				saveToTemp: Type.Optional(
					Type.Boolean({
						description: 'Save the output to a temp file and return its path.',
					}),
				),
				url: Type.String({ description: 'URL to fetch' }),
			}),
		}),
	);
};

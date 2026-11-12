/**
 * Image generation tool: OpenAI Images API through the `openai` provider configured in Pi. The API
 * key comes from `ctx.modelRegistry.getProviderAuth`; the base URL comes from `getProvider`, where
 * a `models.json` `baseUrl` overrides the provider's catalog default. Providing `images` routes the
 * call to the edits endpoint; without `images` it uses the generations endpoint. Every result is
 * saved under the temp directory and returned inline with its path.
 */
import { imageObject } from './utils.ts';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { errText, text } from '@repo/shared/text';
import { Buffer } from 'node:buffer';
import { Type } from 'typebox';
import type { Extension } from '@repo/shared/contract';

const DEFAULT_MODEL = 'gpt-image-2.6-sunburst';
/** The edits endpoint accepts at most 16 input images. */
const MAX_IMAGES = 16;

/** Input MIME type by file extension. */
const INPUT_MIME: Record<string, string> = {
	gif: 'image/gif',
	jpeg: 'image/jpeg',
	jpg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp',
};

/** Output MIME type and file extension by requested output format. */
const OUTPUT_FORMATS: Record<'jpeg' | 'png' | 'webp', { ext: string; mime: string }> = {
	jpeg: { ext: 'jpg', mime: 'image/jpeg' },
	png: { ext: 'png', mime: 'image/png' },
	webp: { ext: 'webp', mime: 'image/webp' },
};

export type ImageGenOptions = {
	/** Text description of the desired image or edit. */
	prompt: string;
	/** Image model; defaults to `gpt-image-2.6-sunburst`. */
	model?: string;
	/** Local paths of input images to edit or use as references, in order. */
	images?: Array<string>;
	/** Local path of a PNG mask applied to the first input image. */
	mask?: string;
	/** Local path of a transparent PNG annotation overlay applied to the first input image. */
	markup?: string;
	/** How strongly the model preserves details from the input images. */
	input_fidelity?: 'high' | 'low';
	/**
	 * `WIDTHxHEIGHT` (edges divisible by 16, ratio 1:3 to 3:1, max edge 3840), a standard size, or
	 * `auto`.
	 */
	size?: string;
	/** Rendering quality; `xhigh` and `max` need GPT Image 2.5 or newer. */
	quality?: 'auto' | 'high' | 'low' | 'max' | 'medium' | 'xhigh';
	/** `transparent` requires `png` or `webp` output. */
	background?: 'auto' | 'opaque' | 'transparent';
	/** Planning effort, independent of rendering quality. */
	complexity?: 'high' | 'low' | 'medium';
	/** Content-moderation strictness. */
	moderation?: 'auto' | 'low';
	/** Number of images to generate. */
	n?: number;
	/** Output file format; defaults to `png`. */
	output_format?: 'jpeg' | 'png' | 'webp';
	/** Compression level (0-100) for `jpeg` or `webp` output. */
	output_compression?: number;
};

/** The request-relevant part of Pi's resolved provider auth. */
export type ImageGenAuth = { apiKey: string; baseUrl?: string };

export type ImageGenResult = {
	/** Endpoint that served the request. */
	endpoint: 'edits' | 'generations';
	/** Effective image model. */
	model: string;
	/** Base64 image data, MIME type, and saved path, one per generated image. */
	images: Array<{ data: string; mimeType: string; path: string }>;
};

/** Read a local image file into the base64 data-URL form the Images API accepts. */
async function loadDataUrl(path: string): Promise<string> {
	const ext = /\.(?<ext>[a-z0-9]+)$/iu.exec(path)?.groups?.ext?.toLowerCase() ?? '';
	const mime = INPUT_MIME[ext];
	if (mime === undefined) throw new Error(`unsupported image file extension: ${path}`);
	const data = Buffer.from(await Bun.file(path).arrayBuffer()).toString('base64');
	return `data:${mime};base64,${data}`;
}

/**
 * Generate or edit images through the OpenAI Images API. `opts.images` non-empty selects the `POST
 * /images/edits` endpoint (input images, `mask`, `markup`, `input_fidelity`); otherwise the call
 * goes to `POST /images/generations`. Each returned image is also saved under the temp directory.
 */
export async function imageGen(
	opts: ImageGenOptions,
	auth: ImageGenAuth,
	signal?: AbortSignal,
): Promise<ImageGenResult> {
	const inputPaths = opts.images ?? [];
	if (inputPaths.length > MAX_IMAGES)
		throw new Error(`images accepts at most ${MAX_IMAGES} paths`);
	if (opts.mask !== undefined && opts.markup !== undefined)
		throw new Error('mask and markup cannot be combined');
	if ((opts.mask !== undefined || opts.markup !== undefined) && inputPaths.length === 0)
		throw new Error('mask and markup require at least one image in images');

	const model = opts.model ?? DEFAULT_MODEL;
	const editing = inputPaths.length > 0;
	const base = (auth.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/u, '');

	const body: Record<string, unknown> = { model, prompt: opts.prompt };
	if (editing) {
		const inputUrls = await Promise.all(inputPaths.map(loadDataUrl));
		body.images = inputUrls.map((image_url) => ({ image_url }));
		if (opts.mask !== undefined) body.mask = { image_url: await loadDataUrl(opts.mask) };
		if (opts.markup !== undefined) body.markup = { image_url: await loadDataUrl(opts.markup) };
		if (opts.input_fidelity !== undefined) body.input_fidelity = opts.input_fidelity;
	}
	for (const [key, value] of Object.entries({
		background: opts.background,
		complexity: opts.complexity,
		moderation: opts.moderation,
		n: opts.n,
		output_compression: opts.output_compression,
		output_format: opts.output_format,
		quality: opts.quality,
		size: opts.size,
	}))
		if (value !== undefined) body[key] = value;

	const response = await fetch(`${base}/images/${editing ? 'edits' : 'generations'}`, {
		body: JSON.stringify(body),
		headers: { authorization: `Bearer ${auth.apiKey}`, 'content-type': 'application/json' },
		method: 'POST',
		signal,
	});
	const payload = await response.text();
	if (!response.ok) throw new Error(`image API ${response.status}: ${payload.slice(0, 1000)}`);

	const generated = (JSON.parse(payload) as { data?: Array<{ b64_json?: string }> }).data ?? [];
	const results = generated.flatMap((image) =>
		image.b64_json === undefined ? [] : [image.b64_json],
	);
	if (results.length === 0 || results.length !== generated.length)
		throw new Error(`image API returned no image data: ${payload.slice(0, 1000)}`);

	const format = OUTPUT_FORMATS[opts.output_format ?? 'png'];
	const images: ImageGenResult['images'] = [];
	for (const [index, data] of results.entries()) {
		const suffix = results.length > 1 ? `-${index}` : '';
		const path = `${process.env.TMPDIR ?? '/tmp'}/image-gen-${crypto.randomUUID()}${suffix}.${format.ext}`;
		await Bun.write(path, Buffer.from(data, 'base64'));
		images.push({ data, mimeType: format.mime, path });
	}
	return { endpoint: editing ? 'edits' : 'generations', images, model };
}

// Extension that registers the `image_gen` tool.
const background = Type.Union(
	[Type.Literal('transparent'), Type.Literal('opaque'), Type.Literal('auto')],
	{ description: 'Output background; `transparent` requires png or webp output format.' },
);
const complexity = Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')], {
	description: 'Planning effort spent before rendering, independent of quality.',
});
const inputImages = Type.Array(
	Type.String({ description: 'Local path of an input image, in order' }),
	{
		description: `Input images to edit or use as references (up to ${MAX_IMAGES}); non-empty selects the edits endpoint.`,
		maxItems: MAX_IMAGES,
	},
);
const inputFidelity = Type.Union([Type.Literal('high'), Type.Literal('low')], {
	description: 'How strongly to preserve details from the input images.',
});
const moderation = Type.Union([Type.Literal('low'), Type.Literal('auto')], {
	description: 'Content-moderation strictness; `low` is less restrictive.',
});
const outputFormat = Type.Union([Type.Literal('png'), Type.Literal('jpeg'), Type.Literal('webp')], {
	description: 'Output file format; defaults to png.',
});
const quality = Type.Union(
	[
		Type.Literal('low'),
		Type.Literal('medium'),
		Type.Literal('high'),
		Type.Literal('xhigh'),
		Type.Literal('max'),
		Type.Literal('auto'),
	],
	{ description: 'Rendering quality; defaults to auto.' },
);
/** Generated image content plus the file it was saved to. */
const savedImageObject = Type.Intersect(
	[
		imageObject,
		Type.Object({ path: Type.String({ description: 'Path of the saved generated image' }) }),
	],
	{ description: 'Generated image content with its saved file path' },
);

export const toolImageGen: Extension = (pi) => {
	pi.registerTool(
		defineTool({
			description:
				'Generate or edit images with the OpenAI Images API. Pass local file paths in `images` to edit them or use them as references (routed to the edits endpoint; reference them by position in the prompt: "image 1", "image 2"); omit `images` to generate from the prompt. Results are saved under the temp directory and returned inline with their paths.',
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				try {
					const auth = (await ctx.modelRegistry.getProviderAuth('openai'))?.auth;
					if (auth?.apiKey === undefined)
						throw new Error(
							'OpenAI provider is not authenticated; run /login openai first',
						);
					// A credential-level baseUrl overrides the provider baseUrl, mirroring Pi's own model requests.
					const result = await imageGen(
						params,
						{
							apiKey: auth.apiKey,
							baseUrl:
								auth.baseUrl ?? ctx.modelRegistry.getProvider('openai')?.baseUrl,
						},
						signal,
					);
					const summary = [
						`Generated ${result.images.length} image${result.images.length > 1 ? 's' : ''} via ${result.endpoint} (model ${result.model}):`,
						...result.images.map((image) => image.path),
					].join('\n');
					return {
						content: [
							{ text: summary, type: 'text' } as const,
							...result.images.map(
								(image) =>
									({
										data: image.data,
										mimeType: image.mimeType,
										type: 'image',
									}) as const,
							),
						],
						details: undefined,
						structuredContent: result.images.map((image) => ({
							data: image.data,
							mimeType: image.mimeType,
							path: image.path,
							type: 'image',
						})),
					};
				} catch (error) {
					return text(errText(error), true);
				}
			},
			exposure: 'deferred',
			label: 'Image Gen',
			name: 'image_gen',
			outputSchema: Type.Array(savedImageObject, {
				description: 'Generated images with their saved file paths',
			}),
			parameters: Type.Object({
				background: Type.Optional(background),
				complexity: Type.Optional(complexity),
				images: Type.Optional(inputImages),
				input_fidelity: Type.Optional(inputFidelity),
				markup: Type.Optional(
					Type.String({
						description:
							'Local path of a transparent PNG annotation overlay applied to the first input image; not combinable with mask.',
					}),
				),
				mask: Type.Optional(
					Type.String({
						description:
							'Local path of a PNG mask with an alpha channel, applied to the first input image.',
					}),
				),
				model: Type.Optional(
					Type.String({ description: `Image model; defaults to ${DEFAULT_MODEL}.` }),
				),
				moderation: Type.Optional(moderation),
				n: Type.Optional(
					Type.Integer({
						description: 'Number of images to generate (1-10).',
						maximum: 10,
						minimum: 1,
					}),
				),
				output_compression: Type.Optional(
					Type.Integer({
						description: 'Compression level 0-100 for jpeg or webp output.',
						maximum: 100,
						minimum: 0,
					}),
				),
				output_format: Type.Optional(outputFormat),
				prompt: Type.String({
					description:
						'Text description of the desired image or edit. For edits, state invariants ("change only X; keep Y unchanged"). Reference inputs by position: "image 1", "image 2".',
				}),
				quality: Type.Optional(quality),
				size: Type.Optional(
					Type.String({
						description:
							'"WIDTHxHEIGHT" (edges divisible by 16, ratio 1:3 to 3:1, max edge 3840), a standard size (1024x1024, 1536x1024, 1024x1536), or "auto".',
					}),
				),
			}),
		}),
	);
};

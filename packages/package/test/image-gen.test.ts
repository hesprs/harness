import { tmpRoot } from './utils';
import { imageGen, toolImageGen } from '@/tools/image-gen.ts';
import { test, expect } from 'bun:test';
import { Buffer } from 'node:buffer';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

// 1x1 transparent PNG.
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
	'base64',
);

// Nothing listens there; requests that get past validation fail fast.
const AUTH = { apiKey: 'test-key', baseUrl: 'http://127.0.0.1:1' };

test('imageGen generates via the generations endpoint and saves the image', async () => {
	let seen: { body: Record<string, unknown>; url: string } | undefined;
	using server = Bun.serve({
		async fetch(req) {
			seen = { body: (await req.json()) as Record<string, unknown>, url: req.url };
			return Response.json({ data: [{ b64_json: PNG.toString('base64') }] });
		},
		port: 0,
	});
	const result = await imageGen(
		{ prompt: 'a red cube' },
		{ apiKey: 'test-key', baseUrl: server.url.toString() },
	);
	expect(result.endpoint).toBe('generations');
	expect(result.model).toBe('gpt-image-2.6-sunburst');
	expect(seen?.url).toBe(`${server.url}images/generations`);
	expect(seen?.body.model).toBe('gpt-image-2.6-sunburst');
	expect(seen?.body.prompt).toBe('a red cube');
	expect(result.images.length).toBe(1);
	expect(result.images[0]?.mimeType).toBe('image/png');
	expect(result.images[0]?.path.endsWith('.png')).toBe(true);
	expect(new Uint8Array(await Bun.file(result.images[0]?.path ?? '').arrayBuffer())).toEqual(
		new Uint8Array(PNG),
	);
});

test('imageGen edits via the edits endpoint with data-URL images and mask', async () => {
	const root = tmpRoot();
	try {
		const input = join(root, 'in.png');
		const mask = join(root, 'mask.png');
		await Bun.write(input, PNG);
		await Bun.write(mask, PNG);
		let seen: { body: Record<string, unknown>; url: string } | undefined;
		using server = Bun.serve({
			async fetch(req) {
				seen = { body: (await req.json()) as Record<string, unknown>, url: req.url };
				return Response.json({ data: [{ b64_json: PNG.toString('base64') }] });
			},
			port: 0,
		});
		const result = await imageGen(
			{ images: [input], input_fidelity: 'high', mask, prompt: 'make it blue' },
			{ apiKey: 'test-key', baseUrl: server.url.toString() },
		);
		expect(result.endpoint).toBe('edits');
		expect(seen?.url).toBe(`${server.url}images/edits`);
		expect(seen?.body.images).toEqual([
			{ image_url: `data:image/png;base64,${PNG.toString('base64')}` },
		]);
		expect(seen?.body.mask).toEqual({
			image_url: `data:image/png;base64,${PNG.toString('base64')}`,
		});
		expect(seen?.body.input_fidelity).toBe('high');
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test('imageGen numbers multiple results and maps output_format to extension and MIME', async () => {
	using server = Bun.serve({
		fetch: () =>
			Response.json({
				data: [{ b64_json: PNG.toString('base64') }, { b64_json: PNG.toString('base64') }],
			}),
		port: 0,
	});
	const result = await imageGen(
		{ output_format: 'jpeg', prompt: 'two cats' },
		{ apiKey: 'test-key', baseUrl: server.url.toString() },
	);
	expect(result.images.length).toBe(2);
	expect(result.images[0]?.path.endsWith('-0.jpg')).toBe(true);
	expect(result.images[1]?.path.endsWith('-1.jpg')).toBe(true);
	expect(result.images[0]?.mimeType).toBe('image/jpeg');
});

test('imageGen rejects with the API status on error responses', async () => {
	using server = Bun.serve({
		fetch: () => new Response('bad request', { status: 400 }),
		port: 0,
	});
	// oxlint-disable-next-line typescript/await-thenable
	await expect(
		imageGen({ prompt: 'x' }, { apiKey: 'test-key', baseUrl: server.url.toString() }),
	).rejects.toThrow('image API 400');
});

test('imageGen rejects mask and markup without input images', async () => {
	// oxlint-disable-next-line typescript/await-thenable
	await expect(imageGen({ mask: '/tmp/m.png', prompt: 'x' }, AUTH)).rejects.toThrow(
		'require at least one image',
	);
	// oxlint-disable-next-line typescript/await-thenable
	await expect(imageGen({ markup: '/tmp/m.png', prompt: 'x' }, AUTH)).rejects.toThrow(
		'require at least one image',
	);
});

test('imageGen rejects combining mask with markup', async () => {
	// oxlint-disable-next-line typescript/await-thenable
	await expect(
		imageGen(
			{ images: ['/tmp/a.png'], markup: '/tmp/m.png', mask: '/tmp/k.png', prompt: 'x' },
			AUTH,
		),
	).rejects.toThrow('cannot be combined');
});

test('imageGen rejects more than 16 input images', async () => {
	const images = Array.from({ length: 17 }, (_, index) => `/tmp/fake-${index}.png`);
	// oxlint-disable-next-line typescript/await-thenable
	await expect(imageGen({ images, prompt: 'x' }, AUTH)).rejects.toThrow('at most 16');
});

test('imageGen rejects input images with unsupported extensions', async () => {
	const root = tmpRoot();
	try {
		const input = join(root, 'photo.tiff');
		await Bun.write(input, PNG);
		// oxlint-disable-next-line typescript/await-thenable
		await expect(imageGen({ images: [input], prompt: 'x' }, AUTH)).rejects.toThrow(
			'unsupported image file extension',
		);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

/** Register the tool on a fake Pi and return the captured tool. */
function registeredImageGenTool() {
	const tools: Array<unknown> = [];
	void toolImageGen({
		registerTool: (tool: unknown) => {
			tools.push(tool);
		},
	} as unknown as Parameters<typeof toolImageGen>[0]);
	return tools[0] as {
		execute: (
			toolCallId: string,
			params: { prompt: string },
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: unknown,
		) => Promise<{ isError?: boolean }>;
	};
}

test('image_gen execute resolves the base URL from the provider config and sends the stored key', async () => {
	let seen: { auth: string | null; url: string } | undefined;
	using server = Bun.serve({
		fetch(req) {
			seen = { auth: req.headers.get('authorization'), url: req.url };
			return Response.json({ data: [{ b64_json: PNG.toString('base64') }] });
		},
		port: 0,
	});
	const tool = registeredImageGenTool();
	const result = await tool.execute('call-1', { prompt: 'a red cube' }, undefined, undefined, {
		modelRegistry: {
			getProvider: () => ({ baseUrl: server.url.toString() }),
			getProviderAuth: () => ({ auth: { apiKey: 'wrapper-key' } }),
		},
	});
	expect(seen?.url).toBe(`${server.url}images/generations`);
	expect(seen?.auth).toBe('Bearer wrapper-key');
	expect(result.isError).toBeUndefined();
});

test('image_gen execute reports an unauthenticated provider as an error', async () => {
	const tool = registeredImageGenTool();
	const result = await tool.execute('call-1', { prompt: 'x' }, undefined, undefined, {
		// oxlint-disable-next-line unicorn/no-useless-undefined
		modelRegistry: { getProvider: () => undefined, getProviderAuth: () => undefined },
	});
	expect(result.isError).toBe(true);
});

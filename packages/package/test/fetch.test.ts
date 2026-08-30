import { test, expect } from 'bun:test';
import { extractHtml, fetchUrl } from '@/tools/fetch.ts';
import { makePdf } from './utils';

const HTML = `<!doctype html><html><head><title>Test Page</title></head>
<body><main><article><h1>Article Title</h1><p>Some <a href="/sub">linked</a> paragraph.</p></article></main>
<nav>navigation junk</nav></body></html>`;

test('extractHtml converts HTML to markdown with absolute links', async () => {
	const md = await extractHtml(HTML, 'https://example.com/page');
	expect(md).toContain('Article Title');
	expect(md).toContain('[linked](https://example.com/sub)');
	expect(md).not.toContain('navigation junk');
});

test('fetchUrl raw returns the response body', async () => {
	using server = Bun.serve({
		fetch: () => new Response('plain body', { headers: { 'content-type': 'text/plain' } }),
	});
	const out = await fetchUrl({ format: 'raw', url: server.url.toString() });
	expect(out.content).toBe('plain body');
});

test('fetchUrl extract converts HTML pages to markdown', async () => {
	using server = Bun.serve({
		fetch: () => new Response(HTML, { headers: { 'content-type': 'text/html' } }),
	});
	const out = await fetchUrl({ url: `${server.url}article` });
	expect(out.content).toContain('Article Title');
	expect(out.content).not.toContain('navigation junk');
});

test('fetchUrl extract converts PDF responses to markdown', async () => {
	using server = Bun.serve({
		fetch: () =>
			new Response(new Uint8Array(makePdf('Fetched PDF Text')), {
				headers: { 'content-type': 'application/pdf' },
			}),
	});
	const out = await fetchUrl({ url: `${server.url}doc.pdf` });
	expect(out.content.toLowerCase()).toContain('fetched');
});

test('fetchUrl appends query params', async () => {
	using server = Bun.serve({
		fetch: (req) => new Response(new URL(req.url).searchParams.get('q') ?? ''),
	});
	const out = await fetchUrl({ params: { q: 'needle' }, url: server.url.toString() });
	expect(out.content).toBe('needle');
});

test('fetchUrl saveToTemp writes bytes to a temp file and returns its path', async () => {
	using server = Bun.serve({ fetch: () => new Response('saved content') });
	const { content: path } = await fetchUrl({ saveToTemp: true, url: server.url.toString() });
	expect(path).not.toContain('saved content');
	expect(await Bun.file(path).text()).toBe('saved content');
});

test('fetchUrl saveToTemp saves the extracted output, not raw bytes', async () => {
	using server = Bun.serve({
		fetch: () => new Response(HTML, { headers: { 'content-type': 'text/html' } }),
	});
	const { content: path } = await fetchUrl({ saveToTemp: true, url: server.url.toString() });
	const content = await Bun.file(path).text();
	expect(content).toContain('Article Title');
	expect(content).not.toContain('<html>');
});

test('fetchUrl raw + saveToTemp preserves the exact byte stream', async () => {
	const bytes = new Uint8Array(makePdf('Binary PDF'));
	using server = Bun.serve({
		fetch: () => new Response(bytes, { headers: { 'content-type': 'application/pdf' } }),
	});
	const { content: path } = await fetchUrl({
		format: 'raw',
		saveToTemp: true,
		url: server.url.toString(),
	});
	expect(new Uint8Array(await Bun.file(path).arrayBuffer())).toEqual(bytes);
});

test('fetchUrl raw + saveToTemp preserves the exact byte stream', async () => {
	const bytes = new Uint8Array(makePdf('Binary PDF'));
	using server = Bun.serve({
		fetch: () => new Response(bytes, { headers: { 'content-type': 'application/pdf' } }),
	});
	const { content: path } = await fetchUrl({
		format: 'raw',
		saveToTemp: true,
		url: server.url.toString(),
	});
	expect(path.endsWith('.pdf')).toBe(true); // MIME-derived extension
	expect(new Uint8Array(await Bun.file(path).arrayBuffer())).toEqual(bytes);
});

test('fetchUrl save-to-file extensions: mime, magic bytes, and markdown', async () => {
	// Generic MIME type; the path decides which bytes to serve.
	using server = Bun.serve({
		fetch: (req) =>
			req.url.endsWith('/file')
				? new Response(new Uint8Array(makePdf('x')), {
						headers: { 'content-type': 'application/octet-stream' },
					})
				: new Response('page', { headers: { 'content-type': 'application/octet-stream' } }),
		port: 0,
	});
	// URL extension when the MIME type is generic.
	const { content: fromUrl } = await fetchUrl({
		format: 'raw',
		saveToTemp: true,
		url: `${server.url}doc.html`,
	});
	expect(fromUrl.endsWith('.html')).toBe(true);
	// Extension-less URL: magic bytes decide.
	const { content: sniffed } = await fetchUrl({
		format: 'raw',
		saveToTemp: true,
		url: `${server.url}file`,
	});
	expect(sniffed.endsWith('.pdf')).toBe(true);

	// Extracted output is always markdown.
	using text = Bun.serve({
		fetch: () => new Response('plain', { headers: { 'content-type': 'text/plain' } }),
		port: 0,
	});
	const { content: md } = await fetchUrl({ saveToTemp: true, url: text.url.toString() });
	expect(md.endsWith('.md')).toBe(true);
});

test('fetchUrl returns binary images as base64 image payloads, not text', async () => {
	// 1x1 transparent PNG.
	const png = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
		'base64',
	);
	using server = Bun.serve({
		fetch: () => new Response(png, { headers: { 'content-type': 'image/png' } }),
	});
	const out = await fetchUrl({ url: `${server.url}pixel.png` });
	expect(out.image?.mimeType).toBe('image/png');
	expect(out.image?.data).toBe(png.toString('base64'));
	expect(out.content).not.toContain('\u0000');
});

test('fetchUrl rejects on HTTP error status', async () => {
	using server = Bun.serve({ fetch: () => new Response('nope', { status: 404 }) });
	// oxlint-disable-next-line typescript/await-thenable
	await expect(fetchUrl({ url: server.url.toString() })).rejects.toThrow();
});

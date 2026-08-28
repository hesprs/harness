import { test, expect } from 'bun:test';
import { searchExa } from '@/tools/search.ts';

/** Minimal streamable-HTTP MCP server recording incoming requests. */
function makeMcpServer() {
	type RecordedRequest = {
		body: {
			id?: number;
			jsonrpc?: string;
			method?: string;
			params?: Record<string, unknown>;
		};
		session?: string | undefined;
	};
	const requests: Array<RecordedRequest> = [];
	const sse = (payload: unknown) =>
		new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
			headers: { 'content-type': 'text/event-stream' },
		});
	const server = Bun.serve({
		fetch: async (req) => {
			const body = (await req.json()) as Record<string, unknown>;
			requests.push({ body, session: req.headers.get('mcp-session-id') ?? undefined });
			if (body.method === 'initialize')
				return new Response(
					`event: message\ndata: ${JSON.stringify({
						id: body.id,
						jsonrpc: '2.0',
						result: {
							capabilities: {},
							protocolVersion: '2025-03-26',
							serverInfo: { name: 'exa' },
						},
					})}\n\n`,
					{
						headers: {
							'content-type': 'text/event-stream',
							'mcp-session-id': 'sess-1',
						},
					},
				);

			if (body.method === 'tools/call')
				return sse({
					id: body.id,
					jsonrpc: '2.0',
					result: {
						content: [{ text: 'Title: First\nURL: https://a.dev', type: 'text' }],
					},
				});

			return new Response(undefined, { status: 202 });
		},
	});
	return { requests, server };
}

test('searchExa runs the keyless MCP handshake and returns the result text', async () => {
	const { server, requests } = makeMcpServer();
	const text = await searchExa({ count: 3, query: 'bun webview' }, `${server.url}mcp`);
	expect(text).toContain('https://a.dev');

	const init = requests[0];
	expect(init?.body.method).toBe('initialize');
	// No API key material is ever sent.
	for (const req of requests) expect(req.body).not.toHaveProperty('apiKey');

	const call = requests.find((r) => r.body.method === 'tools/call');
	expect(call?.session).toBe('sess-1');
	expect(call?.body.params).toEqual({
		arguments: { numResults: 3, query: 'bun webview' },
		name: 'web_search_exa',
	});
	await server.stop(true);
});

test('searchExa surfaces JSON-RPC errors', async () => {
	using server = Bun.serve({
		fetch: async (req) => {
			const body = (await req.json()) as Record<string, unknown>;
			if (body.method === 'tools/call')
				return new Response(
					`data: ${JSON.stringify({ error: { code: -1, message: 'rate limited' }, id: body.id, jsonrpc: '2.0' })}\n\n`,
					{ headers: { 'content-type': 'text/event-stream' } },
				);

			return new Response(undefined, { status: 202 });
		},
	});
	// oxlint-disable-next-line typescript/await-thenable
	await expect(searchExa({ query: 'x' }, server.url.toString())).rejects.toThrow(/rate limited/u);
});

test('searchExa rejects a non-200 response', async () => {
	using server = Bun.serve({ fetch: () => new Response('Unauthorized', { status: 401 }) });
	// oxlint-disable-next-line typescript/await-thenable
	await expect(searchExa({ query: 'x' }, server.url.toString())).rejects.toThrow(/401/u);
});

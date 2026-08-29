import type { Extension } from '@repo/shared/contract';
/**
 * Search tool: keyless semantic web search via Exa's hosted MCP service
 * (https://mcp.exa.ai/mcp, streamable HTTP, no authentication required).
 */
import { defineTool } from '@earendil-works/pi-coding-agent';
import { errText, text } from '@repo/shared/text';
import { Type } from 'typebox';
import { registerActive } from './common.ts';

export type SearchOptions = {
	query: string;
	count?: number;
};

type JsonRpc = {
	jsonrpc: '2.0';
	id?: number;
	method?: string;
	params?: unknown;
};

/** Parse a `text/event-stream` body and return the JSON-RPC response payload. */
function sseResult(raw: string): {
	result?: { content?: Array<{ text?: string }> };
	error?: { message?: string };
} {
	for (const line of raw.split('\n')) {
		if (!line.startsWith('data: ')) continue;
		const parsed = JSON.parse(line.slice(6)) as {
			result?: { content?: Array<{ text?: string }> };
			error?: { message?: string };
		};
		if (parsed.result !== undefined || parsed.error !== undefined) return parsed;
	}
	throw new Error('no JSON-RPC response in server-sent events');
}

/** Exa keyless search through the hosted MCP endpoint; returns the result text. */
export async function searchExa(
	opts: SearchOptions,
	endpoint = 'https://mcp.exa.ai/mcp',
): Promise<string> {
	const headers = {
		accept: 'application/json, text/event-stream',
		'content-type': 'application/json',
	};
	const rpc = (body: JsonRpc, sessionId?: string) =>
		fetch(endpoint, {
			body: JSON.stringify(body),
			headers:
				sessionId === undefined ? headers : { ...headers, 'mcp-session-id': sessionId },
			method: 'POST',
		});

	const init = await rpc({
		id: 1,
		jsonrpc: '2.0',
		method: 'initialize',
		params: {
			capabilities: {},
			clientInfo: { name: 'harness', version: '1.0.0' },
			protocolVersion: '2025-03-26',
		},
	});
	if (!init.ok) throw new Error(`Exa MCP initialize failed: ${init.status}`);
	const sessionId = init.headers.get('mcp-session-id') ?? undefined;

	const notify = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);
	if (!notify.ok) throw new Error(`Exa MCP handshake failed: ${notify.status}`);

	const call = await rpc(
		{
			id: 2,
			jsonrpc: '2.0',
			method: 'tools/call',
			params: {
				arguments: { numResults: opts.count ?? 5, query: opts.query },
				name: 'web_search_exa',
			},
		},
		sessionId,
	);
	if (!call.ok) throw new Error(`Exa search failed: ${call.status} ${call.statusText}`);
	const parsed = sseResult(await call.text());
	if (parsed.error !== undefined) throw new Error(`Exa search failed: ${parsed.error.message}`);
	const content = parsed.result?.content?.[0]?.text;
	if (content === undefined) throw new Error('Exa search returned no content');
	return content;
}

// Extension that registers the `search` tool.
export const toolSearch: Extension = (pi) => {
	registerActive(
		pi,
		defineTool({
			description: 'Semantic web search via Exa.',
			async execute(_toolCallId, params) {
				try {
					return text(await searchExa({ count: params.count, query: params.query }));
				} catch (error) {
					return text(errText(error), true);
				}
			},
			label: 'Search',
			name: 'search',
			parameters: Type.Object({
				count: Type.Optional(Type.Number({ description: 'Number of results' })),
				query: Type.String({ description: 'Search query' }),
			}),
		}),
	);
};

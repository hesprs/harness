/** Register MCP servers programmatically. Servers connect when the session starts; `mcp.json` entries of the same name take precedence. */
import type { McpServerConfig } from '@earendil-works/pi-coding-agent';
import type { Extension } from '@repo/shared/contract';

export function mcp(name: string, config: McpServerConfig): Extension;
export function mcp(registry: Record<string, McpServerConfig>): Extension;
export function mcp(
	nameOrRegistry: string | Record<string, McpServerConfig>,
	config?: McpServerConfig,
): Extension {
	return (pi) => {
		if (typeof nameOrRegistry === 'string')
			pi.registerMcpServer(nameOrRegistry, config as McpServerConfig);
		else
			for (const [name, cfg] of Object.entries(nameOrRegistry))
				pi.registerMcpServer(name, cfg);
	};
}

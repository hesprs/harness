/**
 * Shared helpers for tool extensions: result shaping and activation.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Plain-text tool result. */

/** Activate a built-in tool by name (stays active alongside already-active tools). */
export function activate(pi: ExtensionAPI, name: string): void {
	pi.setActiveTools([...pi.getActiveTools(), name]);
}

/** Register a custom tool and activate it. */
export function registerActive(
	pi: ExtensionAPI,
	tool: Parameters<ExtensionAPI['registerTool']>[0],
): void {
	pi.registerTool(tool);
	activate(pi, tool.name);
}

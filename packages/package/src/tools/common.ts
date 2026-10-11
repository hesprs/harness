/** Shared helpers for tool extensions: result shaping and activation. */
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';

/** Activate a built-in tool by name (stays active alongside already-active tools). */
export function activate(pi: ExtensionAPI, name: string): void {
	pi.setActiveTools([...pi.getActiveTools(), name]);
}

/** Register a custom tool and activate it. */
export function registerActive(pi: ExtensionAPI, tool: ToolDefinition): void {
	pi.registerTool(tool);
	activate(pi, tool.name);
}

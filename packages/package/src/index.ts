/** The publishable package. `harness.config.ts` imports these to declare agents and compose agent extensions. Agent registration routes through the framework kernel on globalThis (see `@repo/shared/contract`) so all module copies share one registry. */
import type { BaseAgentArgs, NamedAgentArgs } from '@repo/shared/contract';
import { kernel } from '@repo/shared/contract';

// Define extensions that all agents share
export function defineBaseAgent(args: BaseAgentArgs): void {
	kernel().defineBaseAgent(args);
}

// Define a standalone agent, returns the agent name
export function defineAgent(args: NamedAgentArgs): string {
	return kernel().defineAgent(args);
}

export { LEADER_ID } from '@repo/shared/contract';
export { default as personalNote } from '@/note.ts';
export { default as skill } from '@/skill.ts';
export { toolEdit } from '@/tools/edit.ts';
export { toolRead } from '@/tools/read.ts';
export { toolWrite, toolBash, toolFind, toolGrep, toolCodemode } from '@/tools/builtin.ts';
export { toolDelete } from '@/tools/delete.ts';
export { toolFetch } from '@/tools/fetch.ts';
export { toolSearch } from '@/tools/search.ts';
export { toolApplyPatch } from '@/tools/apply-patch.ts';
export { mcp } from '@/tools/mcp.ts';
export { default as toolSpawn } from '@/tools/spawn.ts';

/**
 * The publishable package. `harness.config.ts` imports these to declare
 * agents and compose agent extensions.
 */
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Extension } from '@repo/shared/contract';
import registry from './registry.ts';

// Define extensions that all agents share
export function defineBaseAgent(args: {
	model?: string;
	thinking?: ThinkingLevel;
	prompt?: string;
	extensions?: Array<Extension>;
}): void {
	registry.defineBaseAgent(args);
}

// Define a standalone agent, returns the agent name
export function defineAgent(args: {
	name: string;
	description: string;
	model?: string;
	thinking?: ThinkingLevel;
	prompt?: string;
	extensions?: Array<Extension>;
}): string {
	return registry.defineAgent(args);
}

export { LEADER_ID } from '../../shared/src/contract.ts';
export { default as skill } from '@/skill.ts';
export { toolEdit } from '@/tools/edit.ts';
export { toolRead } from '@/tools/read.ts';
export { toolWrite, toolBash, toolFind, toolGrep } from '@/tools/builtin.ts';
export { toolDelete } from '@/tools/delete.ts';
export { toolFetch } from '@/tools/fetch.ts';
export { toolSearch } from '@/tools/search.ts';
export { toolApplyPatch } from '@/tools/apply-patch.ts';
export { default as toolSpawn } from '@/tools/spawn.ts';

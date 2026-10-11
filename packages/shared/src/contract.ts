import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Protocol identity of the human leader, shared by framework and package. */
export const LEADER_ID = 'commander-00001';

/** Channel of the talkable-info event. A session dispatches it on its own `pi.events` bus to gather what other agents see about it (description, note). Handlers must mutate the payload synchronously — the dispatching session reads it right after emit. */
export const TALKABLE_INFO_CHANNEL = 'harness:talkable-info';

/** What other agents see about a session: one plain string that the session's extensions may rewrite on the talkable-info event. */
export type TalkableInfoEvent = { text: string };

/** Structural contract between the published tools and the live framework kernel (the framework entry stashes it on globalThis). Tools resolve the kernel through this accessor — never via framework imports — so the published package stays self-contained. */
export type KernelContract = {
	spawn: (
		from: string,
		agent: string,
		topic?: string,
	) => Promise<{ sessionId: string; recordPath: string }>;
	deliverTalk: (from: string, to: string, message: string) => Promise<void>;
	bindingOf: (piSessionId: string) => { sessionId: string; appFolder: string } | undefined;
	appFolder: () => string | undefined;
	/** Registration surface for `harness.config.ts`, resolved from globalThis (see kernel()). */
	defineBaseAgent: (args: BaseAgentArgs) => void;
	defineAgent: (args: NamedAgentArgs) => string;
	get: (name: string) => AgentDefinition | undefined;
};

export function kernel(): KernelContract {
	return (globalThis as unknown as { harnessKernel: KernelContract }).harnessKernel;
}

type MaybePromise<T> = T | Promise<T>;

export type Extension = (pi: ExtensionAPI) => MaybePromise<void>;

export type AgentDefinition = {
	name: string;
	description: string;
	model?: string;
	thinking?: ThinkingLevel;
	prompts: Array<string>;
	extensions: Array<Extension>;
};

export type BaseAgentArgs = {
	model?: string;
	thinking?: ThinkingLevel;
	prompt?: string;
	extensions?: Array<Extension>;
};

export type NamedAgentArgs = {
	name: string;
	description: string;
} & BaseAgentArgs;

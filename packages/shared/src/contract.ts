import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Protocol identity of the human leader, shared by framework and package. */
export const LEADER_ID = 'commander-00001';

/**
 * Structural contract between the published tools and the live framework
 * kernel (the framework entry stashes it on globalThis). Tools resolve the
 * kernel through this accessor — never via framework imports — so the
 * published package stays self-contained.
 */
export type KernelContract = {
	spawn: (
		from: string,
		agent: string,
		topic?: string,
	) => Promise<{ sessionId: string; recordPath: string }>;
	deliverTalk: (from: string, to: string, message: string) => Promise<void>;
	bindingOf: (piSessionId: string) => { sessionId: string; appFolder: string } | undefined;
	appFolder: () => string | undefined;
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

type AgentArgs = {
	model?: string;
	thinking?: ThinkingLevel;
	prompt?: string;
	extensions?: Array<Extension>;
};

type NamedAgentArgs = {
	name: string;
	description: string;
} & AgentArgs;

type BaseDefinition = {
	model?: string;
	thinking?: ThinkingLevel;
	prompts: Array<string>;
	extensions: Array<Extension>;
};

type Scope = 'user' | 'cwd';

type Layer = {
	base: BaseDefinition;
	named: Map<string, NamedAgentArgs>;
};

/**
 * Agent registry. Populated by importing `harness.config.ts` files (user
 * scope first, then cwd scope). Definition order is preserved for "first
 * defined agent wins". Effective definitions merge layers in priority
 * order `cwd named > user named > cwd base > user base`: `model`/`thinking`
 * are overridden by the highest layer that sets them, `prompt`/`extensions`
 * accumulate from all layers.
 */
export class Registry {
	private readonly scopes: Record<Scope, Layer> = {
		cwd: { base: { extensions: [], prompts: [] }, named: new Map() },
		user: { base: { extensions: [], prompts: [] }, named: new Map() },
	};
	private readonly order: Array<string> = [];
	private current: Scope = 'user';

	/** Set the scope subsequent define* calls are attributed to. */
	setScope(scope: Scope): void {
		this.current = scope;
	}

	defineBaseAgent(args: AgentArgs): void {
		const base = this.scopes[this.current].base;
		if (args.model !== undefined) base.model = args.model;
		if (args.thinking !== undefined) base.thinking = args.thinking;
		if (args.prompt !== undefined) base.prompts.push(args.prompt);
		if (args.extensions) base.extensions.push(...args.extensions);
	}

	defineAgent(args: NamedAgentArgs): string {
		const named = this.scopes[this.current].named;
		if (!this.order.includes(args.name)) this.order.push(args.name);
		named.set(args.name, args);
		return args.name;
	}

	/** Effective definition of `name`, merged across layers. */
	get(name: string): AgentDefinition | undefined {
		if (!this.order.includes(name)) return undefined;
		const user = this.scopes.user;
		const cwd = this.scopes.cwd;
		// Priority order (highest first) for override fields.
		const overrideOrder = [cwd.named.get(name), user.named.get(name), cwd.base, user.base];
		// Accumulation order (lowest first): user base, cwd base, user named, cwd named.
		const accumOrder = [user.base, cwd.base, user.named.get(name), cwd.named.get(name)];
		const description = cwd.named.get(name)?.description ?? user.named.get(name)?.description;
		if (description === undefined) return undefined;
		let model: string | undefined;
		let thinking: ThinkingLevel | undefined;
		for (const layer of overrideOrder) {
			model ??= layer?.model;
			thinking ??= layer?.thinking;
		}
		const prompts: Array<string> = [];
		const extensions: Array<Extension> = [];
		for (const layer of accumOrder) {
			if (!layer) continue;
			if ('prompts' in layer) {
				prompts.push(...layer.prompts);
				extensions.push(...layer.extensions);
			} else {
				if (layer.prompt !== undefined) prompts.push(layer.prompt);
				if (layer.extensions) extensions.push(...layer.extensions);
			}
		}
		return { description, extensions, model, name, prompts, thinking };
	}

	/** All defined agent names in first-definition order. */
	names(): Array<string> {
		return [...this.order];
	}
}

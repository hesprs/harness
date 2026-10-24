import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
/**
 * Agents module: agent definitions — harness.config.ts loading (user scope first, then trusted cwd
 * scope) and the registry. Loading happens once per process (Bun's import cache cannot be busted,
 * so `/reload` does not refresh definitions).
 */
import type {
	AgentDefinition,
	BaseAgentArgs,
	Extension,
	NamedAgentArgs,
} from '@repo/shared/contract';

type BaseDefinition = {
	model?: string;
	thinking?: ThinkingLevel;
	prompts: Array<string>;
	extensions: Array<Extension>;
};

type Scope = 'user' | 'cwd';

type Layer = { base: BaseDefinition; named: Map<string, NamedAgentArgs> };

/**
 * Agent registry. Populated by importing `harness.config.ts` files (user scope first, then cwd
 * scope). Definition order is preserved for "first defined agent wins". Effective definitions merge
 * layers in priority order `cwd named > user named > cwd base > user base`: `model`/`thinking` are
 * overridden by the highest layer that sets them, `prompt`/`extensions` accumulate from all
 * layers.
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

	defineBaseAgent(args: BaseAgentArgs): void {
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

const registry = new Registry();

const stateFile = () => join(homedir(), '.pi', 'agent', 'harness-state.json');

/** Import existing configs into the registry. cwd config requires project trust. */
async function importConfigs(cwd: string, includeCwd: boolean): Promise<void> {
	const user = join(homedir(), '.pi', 'agent', 'harness.config.ts');
	if (await Bun.file(user).exists()) {
		registry.setScope('user');
		await import(Bun.pathToFileURL(user).href);
	}
	const local = join(cwd, 'harness.config.ts');
	if (includeCwd && (await Bun.file(local).exists())) {
		registry.setScope('cwd');
		await import(Bun.pathToFileURL(local).href);
	}
}

/** Default viewed agent: last manually spawned, else first defined. */
async function defaultAgent(): Promise<string | undefined> {
	const file = Bun.file(stateFile());
	if (!(await file.exists())) return registry.names()[0];
	const { lastSpawnedAgent } = (await file.json()) as { lastSpawnedAgent?: string };
	return lastSpawnedAgent ?? registry.names()[0];
}

async function rememberDefault(agent: string): Promise<void> {
	await Bun.write(stateFile(), JSON.stringify({ lastSpawnedAgent: agent }));
}

export default class Agents {
	private loading: Promise<void> | undefined;

	/** Load harness configs once per process; concurrent callers share one load. */
	private readonly loadConfigs = (cwd: string, includeCwd: boolean): Promise<void> => {
		this.loading ??= importConfigs(cwd, includeCwd).catch((error: unknown) => {
			// A broken config is worth retrying on the next session.
			this.loading = undefined;
			throw error;
		});
		return this.loading;
	};

	root = {
		/** Default viewed agent: last manually spawned, else first defined. */
		defaultAgent,
		defineAgent: (args: NamedAgentArgs) => registry.defineAgent(args),
		defineBaseAgent: (args: BaseAgentArgs) => registry.defineBaseAgent(args),
		get: (name: string) => registry.get(name),
		/** Load harness configs once per process. */
		loadConfigs: this.loadConfigs,
		names: () => registry.names(),
		rememberDefault,
	};
}

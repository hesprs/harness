/**
 * Agents module: agent definitions — harness.config.ts loading (user scope
 * first, then trusted cwd scope), registry access, definition application
 * (tools, extensions, model, thinking) and the default-agent state file.
 * Registers the Instructions prompt section.
 */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Registry } from '@repo/shared/contract';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PromptContext, PromptSection } from '@/Prompt';

/**
 * Shared across module instances: the controller extension and user configs
 * may resolve different copies of this module (dual-package hazard), so the
 * registry lives on globalThis to stay a single singleton.
 */
export const registry = ((globalThis as { harnessRegistry?: Registry }).harnessRegistry ??=
	new Registry());

const WORKING_STYLE = `You are an AI agent working with autonomy. You complete your tasks with high quality, and communicate (talk) with other agents smartly.`;

const stateFile = () => join(homedir(), '.pi', 'agent', 'harness-state.json');

/** Import existing configs into the registry. cwd config requires project trust. */
async function importConfigs(cwd: string, includeCwd: boolean): Promise<void> {
	const user = join(homedir(), '.pi', 'agent', 'harness.config.ts');
	if (existsSync(user)) {
		registry.setScope('user');
		await import(Bun.pathToFileURL(user).href);
	}
	const local = join(cwd, 'harness.config.ts');
	if (includeCwd && existsSync(local)) {
		registry.setScope('cwd');
		await import(Bun.pathToFileURL(local).href);
	}
}

function instructionsSection(ctx: PromptContext): string {
	return [WORKING_STYLE, ...(registry.get(ctx.agent)?.prompts ?? [])].join('\n\n');
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

/** Apply an agent definition to a session: blank agent — no built-ins, only
 * `talk` plus what the definition grants. */
async function applyDefinition(
	pi: ExtensionAPI,
	ctx: Pick<ExtensionContext, 'modelRegistry'>,
	agent: string,
): Promise<void> {
	pi.setActiveTools(['talk']);
	const { extensions, thinking, model } = registry.get(agent) ?? {};
	for (const ext of extensions ?? []) await ext(pi);
	if (model?.includes('/') ?? false) {
		const [provider, ...id] = (model as string).split('/');
		// oxlint-disable-next-line unicorn/no-array-method-this-argument : false positive
		const piModel = ctx.modelRegistry.find(provider ?? '', id.join('/'));
		if (piModel) await pi.setModel(piModel);
	}
	if (thinking) pi.setThinkingLevel(thinking);
}

export default class Agents {
	private configsLoaded = false;

	private readonly loadConfigs = async (cwd: string, includeCwd: boolean): Promise<void> => {
		if (this.configsLoaded) return;
		this.configsLoaded = true;
		await importConfigs(cwd, includeCwd);
	};

	constructor(ctx: { registerSection: (section: PromptSection) => void }) {
		ctx.registerSection({
			priority: 400,
			render: instructionsSection,
			title: 'Instructions',
		});
	}

	root = {
		apply: applyDefinition,
		/** Default viewed agent: last manually spawned, else first defined. */
		defaultAgent,
		get: (name: string) => registry.get(name),
		/** Load harness configs once per process. */
		loadConfigs: this.loadConfigs,
		names: () => registry.names(),
		rememberDefault,
	};
}

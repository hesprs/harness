import WORKER_SOURCE from './codemode-worker.mts?raw';
// oxlint-disable unicorn/require-post-message-target-origin
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
/**
 * Codemode tool, unsandboxed: patches the QuickJS sandbox that Pi's built-in `codemode` tool runs
 * scripts in, replacing its execution with a Bun worker thread. Scripts keep the same surface
 * (`tools.*`, `text`, `image`, `exit`, `console`, `store`, `load`, `ALL_TOOLS`, the host globals
 * and the `// @options` line) but gain TypeScript syntax, the full Bun API, `node:*` modules, and
 * direct file system and network access. Pi's own orchestration stays: tool bridging through
 * `ctx.executeTool()`, store persistence, output formatting, and truncation.
 *
 * Only `CodemodeSandbox.prototype.execute` is replaced, so the built-in tool, its description
 * rendering, its exposure rules, and its docs keep working. The description is corrected at request
 * time, because it claims a QuickJS sandbox without Node, file system, network, or timers.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Extension } from '@repo/shared/contract';

type SandboxTool = {
	name: string;
	description?: string;
	spread?: boolean;
	execute: (args: unknown, context: { signal: AbortSignal }) => unknown;
};

type ScriptOutput =
	| { type: 'text'; text: string; console?: true }
	| { type: 'image'; data: string; mimeType: string };

type ScriptError = {
	kind: 'script' | 'timeout' | 'aborted' | 'sandbox';
	name?: string;
	message: string;
	stack?: string;
};

type ScriptResult =
	| {
			ok: true;
			value: unknown;
			output: Array<ScriptOutput>;
			storeWrites: { set: Record<string, unknown>; delete: Array<string> };
	  }
	| { error: ScriptError; ok: false; output: Array<ScriptOutput> };

/** The sandbox instance Pi's `execute.js` builds: only the members the replacement reads. */
type Sandbox = {
	readonly tools: Array<SandboxTool>;
	readonly globals: Array<SandboxTool>;
	readonly timeoutMs: number;
};

type WorkerMessage =
	| { type: 'output'; item: ScriptOutput }
	| { type: 'call'; target: 'tool' | 'global'; name: string; id: number; args: unknown }
	| {
			type: 'done';
			ok: true;
			value: unknown;
			storeWrites: { set: Record<string, unknown>; delete: Array<string> };
	  }
	| { type: 'done'; ok: false; error: ScriptError };

/** Run `code` in a fresh Bun worker; the worker is terminated as soon as the script settles. */
export function executeInBun(
	sandbox: Sandbox,
	code: string,
	options: { signal?: AbortSignal; store?: Record<string, unknown>; timeoutMs?: number } = {},
): Promise<ScriptResult> {
	const output: Array<ScriptOutput> = [];
	const timeoutMs = options.timeoutMs ?? sandbox.timeoutMs;
	const tools = new Map(sandbox.tools.map((tool) => [tool.name, tool]));
	const globals = new Map(sandbox.globals.map((global) => [global.name, global]));
	const controller = new AbortController();
	const workerUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
	const worker = new Worker(workerUrl);

	return new Promise<ScriptResult>((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (result: ScriptResult): void => {
			if (timer !== undefined) clearTimeout(timer);
			options.signal?.removeEventListener('abort', onAbort);
			controller.abort();
			worker.terminate();
			URL.revokeObjectURL(workerUrl);
			resolve(result);
		};
		const fail = (error: ScriptError): void => finish({ error, ok: false, output });
		const onAbort = (): void =>
			fail({
				kind: 'aborted',
				message:
					options.signal?.reason instanceof Error
						? options.signal.reason.message
						: 'Execution aborted',
			});

		worker.addEventListener('message', (event: MessageEvent<WorkerMessage>) => {
			const message = event.data;
			switch (message.type) {
				case 'output': {
					output.push(message.item);
					break;
				}
				case 'call': {
					const tool = (message.target === 'global' ? globals : tools).get(message.name);
					if (!tool) {
						fail({ kind: 'sandbox', message: `Unknown tool "${message.name}"` });
						return;
					}
					Promise.resolve(tool.execute(message.args, { signal: controller.signal })).then(
						(value) =>
							worker.postMessage({
								id: message.id,
								ok: true,
								type: 'callResult',
								value,
							}),
						(error: unknown) =>
							worker.postMessage({
								error: error instanceof Error ? error.message : String(error),
								id: message.id,
								ok: false,
								type: 'callResult',
							}),
					);
					break;
				}
				case 'done': {
					if (message.ok)
						finish({
							ok: true,
							output,
							storeWrites: message.storeWrites,
							value: message.value,
						});
					else fail(message.error);
					break;
				}
			}
		});
		worker.addEventListener('error', (event: ErrorEvent) =>
			fail({ kind: 'sandbox', message: event.message }),
		);

		if (Number.isFinite(timeoutMs))
			timer = setTimeout(
				() =>
					fail({ kind: 'timeout', message: `Execution timed out after ${timeoutMs} ms` }),
				timeoutMs,
			);
		if (options.signal?.aborted) {
			onAbort();
			return;
		}
		options.signal?.addEventListener('abort', onAbort, { once: true });
		worker.postMessage({
			code,
			globals: sandbox.globals.map(({ name, spread }) => ({ name, spread: spread === true })),
			store: options.store ?? {},
			tools: sandbox.tools.map(({ name, description }) => ({
				description: description ?? '',
				name,
			})),
			type: 'start',
		});
	});
}

const QUICKJS_INTRO =
	'Run JavaScript that calls other tools. The input is raw JavaScript (not JSON, no code fence), run as an async function body in a QuickJS sandbox: top-level `await` and `return` work. No Node, file system, network, or timers.';
const BUN_INTRO =
	'Run JavaScript that orchestrates other tools. The input is raw JS/TS (not JSON, no code fence), run as an async function body in a Bun worker thread. Top-level `await`, `return`, Bun & Node APIs, static / dynamic imports relative to CWD, all work.';
const RUNTIME_NOTE =
	'Runtime: Scripts run in a Bun worker thread with JS/TS syntax, the full Bun API (`Bun.*`, `node:*` modules, `fetch`, timers, `import` of installed packages), and direct file system and network access.';

function rewriteDescription(description: string, docsPath: string): string {
	// Each replacement erases what it matches, so running this again on its own output is a no-op.
	const pointAtSkill = (text: string): string => text.replace(docsPath, 'the `codemode` skill');
	if (description.includes(BUN_INTRO) || description.startsWith(RUNTIME_NOTE))
		return pointAtSkill(description);
	const runtime = description.includes(QUICKJS_INTRO)
		? description.replace(QUICKJS_INTRO, BUN_INTRO)
		: `${RUNTIME_NOTE}\n${description}`;
	return pointAtSkill(runtime);
}

/**
 * Replace the QuickJS execution of the codemode sandbox Pi instantiates. Returns the docs path Pi
 * embeds in the tool description, read from the module that built it, so it is matched exactly.
 */
async function patchPi(): Promise<string> {
	const specifier = Bun.resolveSync('@earendil-works/pi-codemode', dirname(Bun.main));
	const { CodemodeSandbox } = (await import(specifier)) as {
		CodemodeSandbox: { prototype: Record<string, unknown> };
	};
	CodemodeSandbox.prototype.execute = function execute(
		this: Sandbox,
		code: string,
		options?: Parameters<typeof executeInBun>[2],
	) {
		return executeInBun(this, code, options);
	};

	const index = Bun.resolveSync('@earendil-works/pi-coding-agent', dirname(Bun.main));
	const { CODEMODE_DOCS_PATH } = (await import(
		new URL('extensions/codemode/tool.js', pathToFileURL(index)).href
	)) as { CODEMODE_DOCS_PATH: string };
	return CODEMODE_DOCS_PATH;
}

export const toolCodemode: Extension = async (pi: ExtensionAPI) => {
	const docsPath = await patchPi();
	pi.on('context_with_system', (event) => {
		for (const message of event.messages)
			if (message.role === 'system' && message.toolsAdded)
				for (const tool of message.toolsAdded)
					if (tool.name === 'codemode')
						tool.description = rewriteDescription(tool.description, docsPath);
	});
	pi.setActiveTools([...pi.getActiveTools(), 'codemode']);
};

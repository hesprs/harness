import type { AgentSession } from '@earendil-works/pi-coding-agent';
/**
 * The host's Pi module, by identity, and the handoff patches installed on
 * its classes. The extension's ordinary `@earendil-works/pi-coding-agent`
 * import resolves to a private copy (project node_modules, or bun's
 * global-cache fallback — pi's jiti host alias only applies when resolution
 * fails outright), so classes imported normally never match the live TUI's:
 * everything that must share identity with the host — the patches below,
 * background session creation — resolves the host's module instead.
 *
 * Handoff patches:
 * - Shield: a session whose record file matches `shieldPath` survives
 *   `teardownCurrent` — abort() and dispose() become no-ops — so shifting
 *   the controller away does not kill its in-flight turn. The captured
 *   session keeps generating invisibly and is adopted as a background
 *   session.
 * - Displace: pi's TUI main loop awaits prompt() until the turn ends, one
 *   input at a time. A shielded session's turn outlives the swap, so the
 *   loop — and with it every input — would stay frozen until the
 *   background turn finishes. prompt() therefore races the session's
 *   displacement signal, and the shielded abort settles it: the loop
 *   resumes at once while the turn keeps running detached.
 * - Adopt: when `switchSession` targets a record with a live session, the
 *   controller hosts that session object instead of constructing a new one
 *   over the record — mid-generation streaming continues natively.
 * - Rejoin: shifting back to a still-streaming session replays the UI
 *   triggers that fired while nobody was subscribed — the working indicator
 *   (agent_start on the session bus) and the streaming message component
 *   (rebuilt lazily from the next event that carries the message) — so the
 *   in-flight turn renders as if it was never left.
 *
 * Handoff state lives on globalThis: pi loads extension modules without a
 * module cache, so every extension instance gets a fresh copy of this module.
 */
import { AssistantMessageComponent } from '@earendil-works/pi-coding-agent';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LiveSession } from '@/Sessions.ts';

type PiModule = typeof import('@earendil-works/pi-coding-agent');

/** The host's dist/index.js, if this process was started as `pi`. The nix
 * wrapper invokes bun as `bun --bun <dist>/cli.js`, so the entry may sit at
 * any argv position. */
function hostEntry(): string | undefined {
	for (const arg of process.argv.slice(1)) {
		if (basename(arg) !== 'cli.js') continue;
		const dist = dirname(arg);
		// Signature check: pi's dist ships these side by side.
		if (existsSync(join(dist, 'core', 'agent-session.js'))) return join(dist, 'index.js');
	}
	return undefined;
}

let cachedHost: Promise<PiModule> | undefined;

/** The host's live Pi module (or the ordinary import outside a Pi process). */
export function hostPi(): Promise<PiModule> {
	cachedHost ??= (() => {
		const entry = hostEntry();
		if (entry === undefined) return import('@earendil-works/pi-coding-agent');
		// oxlint-disable-next-line no-new-func typescript/no-implied-eval : must bypass jiti/bun specifier resolution to reach the host's module registry
		const nativeImport = new Function('s', 'return import(s)') as (
			s: string,
		) => Promise<PiModule>;
		return nativeImport(pathToFileURL(entry).href);
	})();
	return cachedHost;
}

type HandoffState = {
	/** Record file of the outgoing session: abort/dispose become no-ops. */
	shieldPath: string | undefined;
	/** The session captured by a skipped dispose. */
	captured: LiveSession | undefined;
	/** Record file → live session offered for adoption by switchSession. */
	adoptable: Map<string, LiveSession>;
	/** Live sessions' displacement signals, by session. */
	signals: WeakMap<object, DisplacementSignal>;
};

/** A pending-prompt gate: prompt() races it, displacement settles it. */
type DisplacementSignal = {
	promise: Promise<void>;
	settle: () => void;
};

const handoff: HandoffState = ((globalThis as { harnessHandoff?: HandoffState }).harnessHandoff ??=
	{
		adoptable: new Map(),
		captured: undefined,
		shieldPath: undefined,
		signals: new WeakMap(),
	});

/** The session's current displacement signal, created on demand. */
function signalOf(session: object): DisplacementSignal {
	let signal = handoff.signals.get(session);
	if (signal === undefined) {
		let settle!: () => void;
		signal = {
			promise: new Promise<void>((done) => {
				settle = done;
			}),
			settle,
		};
		handoff.signals.set(session, signal);
	}
	return signal;
}

/** Displace a session: every prompt() promise already racing its current
 * signal settles now (the TUI main loop resumes); later prompts race a
 * fresh one. */
function displace(session: object): void {
	const signal = handoff.signals.get(session);
	if (signal === undefined) return;
	signal.settle();
	handoff.signals.delete(session);
}

let installed: Promise<void> | undefined;

/** Marker for the installed patch set. pi runs extension factories once per
 * session (background sessions included), each loading this module afresh —
 * without the marker every load would re-wrap the prototypes and nest the
 * patches. */
const PATCHED = Symbol.for('harness.handoffPatches');

/** Install the patches on the host's classes — installed eagerly at
 * construction, awaited by every swap path before it tears anything down. */
export function installHandoffPatches(): Promise<void> {
	installed ??= (async () => {
		const { AgentSession, AgentSessionRuntime } = await hostPi();
		const sessionProto = AgentSession.prototype as { [PATCHED]?: boolean };
		if (sessionProto[PATCHED]) return;
		sessionProto[PATCHED] = true;
		const origPrompt = AgentSession.prototype.prompt;
		AgentSession.prototype.prompt = function prompt(
			this: AgentSession,
			text: string,
			options?: Parameters<AgentSession['prompt']>[1],
		): Promise<void> {
			const run = origPrompt.call(this, text, options);
			// The race may abandon `run` (displacement); keep its eventual
			// Rejection observed.
			run.catch(() => {});
			return Promise.race([run, signalOf(this).promise]);
		};

		const origAbort = AgentSession.prototype.abort;
		const origDispose = AgentSession.prototype.dispose;
		AgentSession.prototype.abort = function abort(this: AgentSession) {
			if (this.sessionManager.getSessionFile() === handoff.shieldPath) {
				displace(this);
				return Promise.resolve();
			}
			return origAbort.call(this);
		};
		AgentSession.prototype.dispose = function dispose(this: AgentSession) {
			const file = this.sessionManager.getSessionFile();
			if (file === handoff.shieldPath) {
				// Shielded: skip teardown so the session keeps generating. The
				// Caller picks it up via takeShielded().
				handoff.captured = this;
				return;
			}
			if (file !== undefined) handoff.adoptable.delete(file);
			origDispose.call(this);
		};

		// Host-internal surface used by the adopt path (undocumented, but the
		// Same calls the original switchSession makes).
		type Host = {
			session: AgentSession;
			_services?: unknown;
			emitBeforeSwitch: (
				reason: 'resume',
				targetSessionFile?: string,
			) => Promise<{ cancelled: boolean }>;
			teardownCurrent: (reason: string, targetSessionFile?: string) => Promise<void>;
			apply: (result: {
				session: unknown;
				services: unknown;
				diagnostics: Array<unknown>;
			}) => void;
			finishSessionReplacement: (withSession?: unknown) => Promise<void>;
		};
		const proto = AgentSessionRuntime.prototype as unknown as Record<string, unknown>;
		const origSwitch = proto.switchSession as (
			this: Host,
			sessionPath: string,
			options?: { withSession?: unknown },
		) => Promise<{ cancelled: boolean }>;
		proto.switchSession = async function switchSession(
			this: Host,
			sessionPath: string,
			options?: { withSession?: unknown },
		): Promise<{ cancelled: boolean }> {
			const live = handoff.adoptable.get(resolve(sessionPath));
			if (live === undefined) return origSwitch.call(this, sessionPath, options);
			const before = await this.emitBeforeSwitch('resume', sessionPath);
			if (before.cancelled) return before;
			handoff.adoptable.delete(resolve(sessionPath));
			// Tear down the outgoing session (shielded if the caller armed it),
			// Then host the live one; the interactive rebind attaches the real UI
			// To it, mid-generation.
			await this.teardownCurrent('resume', live.sessionManager.getSessionFile());
			// oxlint-disable-next-line eslint/no-underscore-dangle : pi's private field name on AgentSessionRuntime
			this.apply({ diagnostics: [], services: this._services, session: live });
			await this.finishSessionReplacement(options?.withSession);
			// The UI has rebound by now (finishSessionReplacement rebinds first):
			// Replay the working-indicator trigger for a still-streaming turn.
			announceAdoption(live);
			return { cancelled: false };
		};

		// Rejoin, part 2: assistant message_update/message_end only render when
		// The TUI has a streaming component — which an adopted session's
		// Message_start created before the rebind cleared it. Recreate it
		// Lazily from the first event that carries the message (updates carry
		// The full message, not deltas).
		const { InteractiveMode } = await hostPi();
		const uiProto = InteractiveMode.prototype as unknown as Record<string, unknown>;
		const origHandleEvent = uiProto.handleEvent as (
			this: unknown,
			event: { type: string; message?: { role: string } },
		) => Promise<void> | void;
		uiProto.handleEvent = function handleEvent(
			this: unknown,
			event: { type: string; message?: { role: string } },
		): Promise<void> | void {
			if (
				(event.type === 'message_update' || event.type === 'message_end') &&
				event.message?.role === 'assistant'
			)
				ensureStreamingComponent(this as TuiInternals, event.message as AssistantMessage);

			return origHandleEvent.call(this, event);
		};
	})();
	return installed;
}

/** Arm the shield: the session owning `recordPath` survives its teardown. */
export function shield(recordPath: string): void {
	handoff.shieldPath = resolve(recordPath);
}

/** Take the session captured by a skipped dispose (clears the shield). */
export function takeShielded(): LiveSession | undefined {
	handoff.shieldPath = undefined;
	const captured = handoff.captured;
	handoff.captured = undefined;
	return captured;
}

type AssistantMessage = NonNullable<ConstructorParameters<typeof AssistantMessageComponent>[0]>;
type MarkdownTheme = NonNullable<ConstructorParameters<typeof AssistantMessageComponent>[2]>;
type MarkdownTransformer = NonNullable<
	ConstructorParameters<typeof AssistantMessageComponent>[5]
>[number];

/** The interactive mode's internals the rejoin repair touches. */
export type TuiInternals = {
	streamingComponent: unknown;
	streamingMessage: AssistantMessage | undefined;
	chatContainer: { addChild: (child: unknown) => void };
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string;
	outputPad: number;
	getMarkdownThemeWithSettings: () => MarkdownTheme | undefined;
	getMarkdownTransformers: () => ReadonlyArray<MarkdownTransformer> | undefined;
};

/** Recreate the TUI's streaming message component from the first event that
 * carries the message: an adopted session's message_start fired before the
 * UI rebound, so without this its mid-generation text (and its final
 * message) would never render. No-op when the component already exists. */
export function ensureStreamingComponent(tui: TuiInternals, message: AssistantMessage): void {
	if (tui.streamingComponent !== undefined) return;
	const component = new AssistantMessageComponent(
		undefined,
		tui.hideThinkingBlock,
		tui.getMarkdownThemeWithSettings(),
		tui.hiddenThinkingLabel,
		tui.outputPad,
		tui.getMarkdownTransformers(),
	);
	tui.streamingComponent = component;
	tui.streamingMessage = message;
	tui.chatContainer.addChild(component);
}

/** Replay the working-indicator trigger for an adopted session: the TUI
 * shows the indicator on agent_start, which fired before it rebound. The
 * session bus reaches UI listeners only — the extension bus and record
 * persistence live upstream in the agent-event handler — and the real
 * agent_end clears the indicator when the turn ends. */
export function announceAdoption(live: LiveSession): void {
	if (!live.isStreaming) return;
	const emitter: { _emit: (event: { type: 'agent_start' }) => void } = live as never;
	// oxlint-disable-next-line eslint/no-underscore-dangle : pi's private session-bus emitter, listeners-only
	emitter._emit({ type: 'agent_start' });
}

/** Offer a live session for adoption: the next switch onto its record hosts it. */
export function offerAdoption(recordPath: string, live: LiveSession): void {
	handoff.adoptable.set(resolve(recordPath), live);
}

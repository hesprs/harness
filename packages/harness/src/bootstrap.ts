import type { Kernel } from '@';
/**
 * Bootstrap: per-session host wiring. Binds session identity, applies agent
 * definitions, renders prompts, transforms leader input — delegating all
 * logic to the kernel modules (see ../index.ts).
 */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { errText, text } from '@repo/shared/text';
import { existsSync, renameSync } from 'node:fs';
import { Type } from 'typebox';
import { appSessionsRoot } from '@/model.ts';

const TALK_DESCRIPTION = `Send an message to your leader, a colleague, or a child. The target receives your session ID, your relationship, and the message.
Delivery is asynchronous: your turn continues immediately, and any reply arrives later as another talk to you. If you want to wait for reply, simply stop. Any talk to you will wake you up.
Anyone can also talk to you in this way. MUST communicate with other agents through this, plain output is meaningless and NOT delivered to anyone.`;

/** Per-session glue state: the viewed agent binding of this pi session. */
type Instance = {
	/** '' while no agent is bound (no configs): the session stays Pi-native. */
	agent: string;
	sessionId: string | undefined;
	appFolder: string | undefined;
	topic: string | undefined;
	/** This session's Pi session file (the viewed agent's record). */
	piFile: string | undefined;
	registered: boolean;
	/** Agent whose definition is currently applied (adoption re-fires skip). */
	appliedAgent: string | undefined;
	lastInvocation: Date | undefined;
};

/** Move the session's record file into the app session folder. pi allocated
 * the file in the default sessions dir; entries may already be flushed, so
 * rename first, then re-point the manager (it loads the history back). */
function relocateRecord(
	sessionManager: {
		getSessionFile: () => string | undefined;
		setSessionFile: (file: string) => void;
	},
	target: string,
): void {
	const from = sessionManager.getSessionFile();
	if (from === undefined || from === target) return;
	if (existsSync(from)) renameSync(from, target);
	sessionManager.setSessionFile(target);
}

export default function bootstrap(pi: ExtensionAPI, kernel: Kernel): void {
	// Factory time: pi re-runs this for every session's runner, before the
	// TUI renders history on a switch — the surface must exist by then.
	kernel.registerSurface(pi);
	const instance: Instance = {
		agent: '',
		appFolder: undefined,
		appliedAgent: undefined,
		lastInvocation: undefined,
		piFile: undefined,
		registered: false,
		sessionId: undefined,
		topic: undefined,
	};

	function setFooter(ctx: ExtensionContext): void {
		const label =
			instance.agent === ''
				? 'no session'
				: instance.registered
					? instance.sessionId
					: `new ${instance.agent}`;
		ctx.ui.setStatus('harness', label);
	}

	/** Register the controller session on the first user message. */
	async function ensureRegistered(ctx: ExtensionContext): Promise<void> {
		if (instance.registered || instance.agent === '' || instance.piFile === undefined) return;
		const binding = await kernel.registerViewing({
			agent: instance.agent,
			piSessionId: ctx.sessionManager.getSessionId(),
			...(instance.topic === undefined ? {} : { topic: instance.topic }),
		});
		Object.assign(instance, {
			appFolder: binding.appFolder,
			registered: true,
			sessionId: binding.sessionId,
		});
		setFooter(ctx);
	}

	pi.registerTool(
		defineTool({
			description: TALK_DESCRIPTION,
			async execute(_toolCallId, params) {
				if (instance.sessionId === undefined) return text('session not bound yet', true);
				try {
					await kernel.deliverTalk(instance.sessionId, params.to, params.message);
					return text(`talked to ${params.to}`);
				} catch (error) {
					return text(errText(error), true);
				}
			},
			label: 'Talk',
			name: 'talk',
			parameters: Type.Object({
				message: Type.String({ description: 'Message content' }),
				to: Type.String({ description: 'Target session ID' }),
			}),
		}),
	);

	pi.on('session_start', async (_event, ctx) => {
		await kernel.loadConfigs(ctx.cwd, ctx.isProjectTrusted());
		instance.piFile = ctx.sessionManager.getSessionFile();
		const piSessionId = ctx.sessionManager.getSessionId();
		if (ctx.hasUI) {
			// Controller flavor: this instance drives the interactive session.
			// Re-attaches on every session (a resumed /apps session included):
			// Commands, renderer and foreground delivery bind to the fresh API.
			kernel.attachSession(pi, ctx);
			kernel.useCwd(ctx.cwd);
			// The viewed agent is the record matching this session file, if any.
			const found =
				instance.piFile === undefined
					? undefined
					: await kernel.bindByFile(
							piSessionId,
							instance.piFile,
							appSessionsRoot(ctx.cwd),
						);
			if (found === undefined) {
				// Fresh session file: arm the pending (or default) agent provisionally;
				// Registered on the first user message.
				if (kernel.pendingAgent() === undefined)
					kernel.armPending((await kernel.defaultAgent()) ?? '');
				instance.agent = kernel.pendingAgent() ?? '';
				instance.registered = false;
				instance.sessionId = undefined;
				if (instance.agent !== '') {
					// A new app session begins here if none is active.
					if (kernel.appFolder() === undefined)
						await kernel.beginAppSession(appSessionsRoot(ctx.cwd));
					// Locate the fresh session's record inside the app session before
					// Its first turn; pi allocated the file in the default sessions dir.
					const record = kernel.provisionPending(instance.agent);
					relocateRecord(
						ctx.sessionManager as typeof ctx.sessionManager & {
							setSessionFile: (file: string) => void;
						},
						record.recordPath,
					);
					instance.piFile = record.recordPath;
				}
			} else
				Object.assign(instance, {
					agent: found.agent,
					appFolder: found.appFolder,
					registered: true,
					sessionId: found.sessionId,
					topic: found.topic,
				});
		} else {
			// Background SDK session: identity registered by the spawner.
			const binding = kernel.bindingOf(piSessionId);
			if (binding === undefined) return;
			Object.assign(instance, {
				agent: binding.agent,
				appFolder: binding.appFolder,
				registered: true,
				sessionId: binding.sessionId,
				topic: binding.topic,
			});
		}
		// Re-apply on agent change: the controller's extension instance is shared
		// Across shifts, so the previous agent's tool activations must be replaced.
		// Same-agent re-fires (e.g. adoption) are no-ops.
		if (instance.agent !== '' && instance.appliedAgent !== instance.agent) {
			await kernel.apply(pi, ctx, instance.agent);
			instance.appliedAgent = instance.agent;
		}
		setFooter(ctx);
	});

	pi.on('before_agent_start', async (_event, ctx) => {
		if (instance.agent === '') return; // Pi-native turn
		await ensureRegistered(ctx);
		if (!instance.registered) return; // Not persisted: Pi-native turn
		const now = new Date();
		const systemPrompt = await kernel.render({
			agent: instance.agent,
			appFolder: instance.appFolder ?? '',
			canEditNote: pi
				.getActiveTools()
				.some((tool) => tool === 'write' || tool === 'edit' || tool === 'apply_patch'),
			cwd: ctx.cwd,
			...(instance.lastInvocation === undefined
				? {}
				: { lastInvocation: instance.lastInvocation }),
			now,
			sessionId: instance.sessionId ?? '',
			...(instance.topic === undefined ? {} : { topicPath: instance.topic }),
			systemPrompt: ctx.getSystemPrompt(),
		});
		instance.lastInvocation = now;
		return { systemPrompt };
	});

	// Human input = commander-00001 talking to the viewed session.
	pi.on('input', async (event, ctx) => {
		if (event.source !== 'interactive' || event.text.startsWith('/')) return;
		if (instance.agent === '') return;
		await ensureRegistered(ctx);
		if (instance.sessionId === undefined) return;
		// The app session's display name: the first user message, untransformed.
		await kernel.captureFirstMessage(event.text);
		return {
			action: 'transform',
			text: await kernel.formatLeaderTalk(instance.sessionId, event.text),
		};
	});
}

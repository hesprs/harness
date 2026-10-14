import type { Kernel } from '@';
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
} from '@earendil-works/pi-coding-agent';
import type { TalkableInfoEvent } from '@repo/shared/contract';
import type { FSWatcher } from 'node:fs';
import { defineTool, getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import { Markdown } from '@earendil-works/pi-tui';
import { TALKABLE_INFO_CHANNEL } from '@repo/shared/contract';
import { errText, text } from '@repo/shared/text';
import { watch } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';
import type { LiveSession } from '@/Sessions';
import { encodeTalk, formatTalkNotice } from '@/Controller';
import { appSessionsRoot } from '@/model';

const TALK_DESCRIPTION = `Send an message to another agent. Other agents communicate to you using this tool, you MUST communicate using this tool also; plain output is meaningless and NOT delivered to anyone. Delivery is asynchronous: your turn continues immediately, and any reply arrives later as another talk to you. If you want to wait for reply, simply stop after talking without further tool calls; any incoming talks will wake you up when you have stopped.`;

const WORKING_STYLE = `You are an AI agent working with autonomy. You complete your tasks with high quality, and communicate with other agents smartly.`;

const fmt = new Intl.DateTimeFormat('en-US', {
	day: 'numeric',
	month: 'short',
	year: 'numeric',
});

/** Move the session's record file into the app session folder. pi allocated the file in the default sessions dir; entries may already be flushed, so rename first, then re-point the manager (it loads the history back). */
async function relocateRecord(
	sessionManager: {
		getSessionFile: () => string | undefined;
		setSessionFile: (file: string) => void;
	},
	target: string,
): Promise<void> {
	const from = sessionManager.getSessionFile();
	if (from === undefined || from === target) return;
	if (await Bun.file(from).exists()) await rename(from, target);
	sessionManager.setSessionFile(target);
}

/** One instance per agent session (the interactive one that runs the viewed agent natively, and every background SDK session). Owns everything session-local: identity binding, the agent definition application, prompt construction, the talk tool, talk delivery into this session, and the talkable-info event. Background live sessions attach here so the viewed and background cases keep no abstraction difference. */
export default class Session {
	/** Agent name ('' = no configs: the session stays Pi-native). */
	agent = '';
	sessionId: string | undefined;
	private appFolder: string | undefined;
	private topic: string | undefined;
	/** This session's Pi session file (the viewed agent's record). */
	private piFile: string | undefined;
	/** Viewed sessions register on their first user message. */
	private registered = false;
	/** Agent whose definition is currently applied (adoption re-fires skip). */
	private appliedAgent: string | undefined;
	/** Topic file watcher; caches content for the prompt section. */
	private topicWatcher: FSWatcher | undefined;
	private topicContent = '';
	/** Background SDK session handle; the viewed session runs natively instead. */
	live: LiveSession | undefined;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly kernel: Kernel,
	) {
		// Factory time: pi re-runs this for every session's runner, before the TUI renders history on a switch — the surface must exist by then.
		this.kernel.registerSurface(pi);
		this.registerTalkTool();
		pi.on('session_start', (_, ctx) => this.start(ctx));
		pi.on('before_agent_start', (event, ctx) => this.beginTurn(event, ctx));
		pi.on('input', (event, ctx) => this.leaderInput(event, ctx));
	}

	/** Bind this session's identity and apply the agent definition. */
	private async start(ctx: ExtensionContext): Promise<void> {
		await this.kernel.loadConfigs(ctx.cwd, ctx.isProjectTrusted());
		this.piFile = ctx.sessionManager.getSessionFile();
		const piSessionId = ctx.sessionManager.getSessionId();
		if (ctx.hasUI) {
			// Controller flavor: this instance drives the interactive session. Re-attaches on every session (a resumed /apps session included).
			this.kernel.attachSession(this.pi);
			this.kernel.useCwd(ctx.cwd);
			// The viewed agent is the record matching this session file, if any.
			const found =
				this.piFile === undefined
					? undefined
					: await this.kernel.bindByFile(
							piSessionId,
							this.piFile,
							appSessionsRoot(ctx.cwd),
						);
			if (found === undefined) {
				// Fresh session file: arm the pending (or default) agent provisionally; Registered on the first user message.
				if (this.kernel.pendingAgent() === undefined)
					this.kernel.armPending((await this.kernel.defaultAgent()) ?? '');
				this.agent = this.kernel.pendingAgent() ?? '';
				this.registered = false;
				this.sessionId = undefined;
				if (this.agent !== '') {
					// A new app session begins here if none is active.
					if (this.kernel.appFolder() === undefined)
						await this.kernel.beginAppSession(appSessionsRoot(ctx.cwd));
					// Locate the fresh session's record inside the app session before Its first turn; pi allocated the file in the default sessions dir.
					const record = this.kernel.provisionPending(this.agent);
					await relocateRecord(
						ctx.sessionManager as typeof ctx.sessionManager & {
							setSessionFile: (file: string) => void;
						},
						record.recordPath,
					);
					this.piFile = record.recordPath;
				}
			} else {
				this.agent = found.agent;
				this.appFolder = found.appFolder;
				this.registered = true;
				this.sessionId = found.sessionId;
				this.topic = found.topic;
				await this.setTopic(found.topic);
				this.kernel.bindSession(found.sessionId, this);
			}
		} else {
			// Background SDK session: identity registered by the spawner.
			const binding = this.kernel.bindingOf(piSessionId);
			if (binding === undefined) return;
			this.agent = binding.agent;
			this.appFolder = binding.appFolder;
			this.registered = true;
			this.sessionId = binding.sessionId;
			this.topic = binding.topic;
			await this.setTopic(binding.topic);
			this.kernel.bindSession(binding.sessionId, this);
		}
		// Re-apply on agent change: the controller's session instance is shared Across shifts, so the previous agent's tool activations must be replaced. Same-agent re-fires (e.g. adoption) are no-ops.
		if (this.agent !== '' && this.appliedAgent !== this.agent) {
			await this.apply(ctx);
			this.appliedAgent = this.agent;
		}
		this.footer(ctx);
	}

	/** Blank agent: no built-ins, only `talk` plus what the definition grants. */
	private async apply(ctx: Pick<ExtensionContext, 'modelRegistry'>): Promise<void> {
		this.pi.setActiveTools(['talk']);
		const { extensions, thinking, model } = this.kernel.get(this.agent) ?? {};
		for (const ext of extensions ?? []) await ext(this.pi);
		if (model?.includes('/') ?? false) {
			const [provider, ...id] = (model as string).split('/');
			// oxlint-disable-next-line unicorn/no-array-method-this-argument : false positive
			const piModel = ctx.modelRegistry.find(provider ?? '', id.join('/'));
			if (piModel) await this.pi.setModel(piModel);
		}
		if (thinking) this.pi.setThinkingLevel(thinking);
	}

	/** Register the controller session on the first user message. */
	private async ensureRegistered(ctx: ExtensionContext): Promise<void> {
		if (this.registered || this.agent === '' || this.piFile === undefined) return;
		const binding = this.kernel.registerViewing({
			agent: this.agent,
			piSessionId: ctx.sessionManager.getSessionId(),
			...(this.topic === undefined ? {} : { topic: this.topic }),
		});
		this.appFolder = binding.appFolder;
		this.registered = true;
		this.sessionId = binding.sessionId;
		this.topic = binding.topic;
		await this.setTopic(binding.topic);
		this.kernel.bindSession(binding.sessionId, this);
		this.footer(ctx);
	}

	private footer(ctx: ExtensionContext): void {
		const label =
			this.agent === ''
				? 'no session'
				: this.registered
					? this.sessionId
					: `new ${this.agent}`;
		ctx.ui.setStatus('harness', label);
	}

	/** The system prompt: identity and instructions as preamble; topic and talkables as persisted, diffed sections. */
	private async beginTurn(
		event: BeforeAgentStartEvent,
		ctx: ExtensionContext,
	): Promise<undefined> {
		if (this.agent === '') return undefined; // Pi-native turn
		await this.ensureRegistered(ctx);
		if (!this.registered) return undefined; // Not persisted: Pi-native turn
		const sections = event.systemPromptOptions.sections;
		const topic = this.topicContent.trim();
		if (topic) sections.topic = topic;
		else delete sections.topic;
		if (this.sessionId !== undefined) {
			const entries = this.kernel.talkableFor(this.sessionId);
			if (entries.length > 0) sections.talkables = entries.join('\n');
			else delete sections.talkables;
		}
		event.systemPromptOptions.customPrompt = this.buildPrompt();
	}

	private buildPrompt(): string {
		const identity = [
			`Application session: \`${this.appFolder ?? ''}\``,
			`Your ID: \`${this.sessionId ?? ''}\``,
			`Current date: ${fmt.format(new Date())}`,
			...(this.topic === undefined ? [] : [`Topic: \`${this.topic}\``]),
		].join('\n');
		const instructions = [WORKING_STYLE, ...(this.kernel.get(this.agent)?.prompts ?? [])].join(
			'\n\n',
		);
		return [
			`<meta>\n${identity}\n</meta>`,
			`<instructions>\n${instructions}\n</instructions>`,
		].join('\n\n');
	}

	/** Point the topic watcher at a file; re-binding swaps the watcher. */
	private async setTopic(topic: string | undefined): Promise<void> {
		this.topicWatcher?.close();
		this.topicWatcher = undefined;
		this.topicContent = '';
		if (topic === undefined) return;
		await this.readTopic(topic);
		if (!(await Bun.file(topic).exists())) return;
		this.topicWatcher = watch(topic, { persistent: false }, () => {
			void this.readTopic(topic);
		});
	}

	private async readTopic(topic: string): Promise<void> {
		try {
			this.topicContent = await Bun.file(topic).text();
		} catch {
			this.topicContent = '';
		}
	}

	/** Human input = commander-00001 talking to this session. */
	private async leaderInput(
		event: InputEvent,
		ctx: ExtensionContext,
	): Promise<{ action: 'transform'; text: string } | undefined> {
		if (event.source !== 'interactive' || event.text.startsWith('/')) return undefined;
		if (this.agent === '') return undefined;
		await this.ensureRegistered(ctx);
		if (this.sessionId === undefined) return undefined;
		// The app session's display name: the first user message, untransformed.
		this.kernel.captureFirstMessage(event.text);
		return {
			action: 'transform',
			text: this.kernel.formatLeaderTalk(this.sessionId, event.text),
		};
	}

	private registerTalkTool(): void {
		this.pi.registerTool(
			defineTool({
				description: TALK_DESCRIPTION,
				execute: async (_toolCallId, params) => {
					if (this.sessionId === undefined) return text('session not bound yet', true);
					try {
						await this.kernel.deliverTalk(this.sessionId, params.to, params.message);
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
				/** Show the sent message in the tool result — the human sees what was said, once per talk, instead of a replaceable status notification. */
				renderResult: (result, _options, _theme, context) =>
					new Markdown(
						context.isError
							? result.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
							: `**${context.args.to}**\n\n${context.args.message}`,
						0,
						0,
						getMarkdownTheme(),
					),
			}),
		);
	}

	/** Deliver a talk into this session: background sessions through their live handle (steered mid-generation, prompted when idle), the viewed session through the controller's own conversation. */
	deliver(from: string, rel: string, message: string): void {
		if (this.live !== undefined) {
			const notice = formatTalkNotice(from, rel, message);
			void (this.live.isStreaming
				? this.live.steer(notice)
				: this.live.prompt(notice, { source: 'extension' }));
			return;
		}
		this.pi.sendMessage(encodeTalk(from, rel, message), {
			deliverAs: 'steer',
			triggerTurn: true,
		});
	}

	/** The session's talkable manifest content, dispatched on this session's own event bus; handlers must mutate synchronously. */
	info(base: string): string {
		const event: TalkableInfoEvent = { text: base };
		if (this.sessionId !== undefined)
			try {
				this.pi.events.emit(TALKABLE_INFO_CHANNEL, event);
			} catch {
				// Stale runner (the session shifted away): base info only.
			}

		return event.text;
	}

	/** Note file of this session, by convention inside the app session folder. */
	noteFile(): string | undefined {
		return this.appFolder === undefined || this.sessionId === undefined
			? undefined
			: join(this.appFolder, `${this.sessionId}.md`);
	}

	attachLive(live: LiveSession): void {
		this.live = live;
	}

	detachLive(): LiveSession | undefined {
		const live = this.live;
		this.live = undefined;
		return live;
	}
}

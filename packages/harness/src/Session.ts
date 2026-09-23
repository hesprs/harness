import type { Kernel } from '@';
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
} from '@earendil-works/pi-coding-agent';
import type { SystemReminderEvent, TalkableInfoEvent } from '@repo/shared/contract';
import type { FSWatcher } from 'node:fs';
import { defineTool, getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import { Markdown } from '@earendil-works/pi-tui';
import { SYSTEM_REMINDER_CHANNEL, TALKABLE_INFO_CHANNEL } from '@repo/shared/contract';
import { errText, text } from '@repo/shared/text';
import { existsSync, renameSync, watch } from 'node:fs';
import { join } from 'node:path';
import { Type } from 'typebox';
import type { LiveSession } from '@/Sessions';
import { encodeTalk, formatTalkNotice } from '@/Controller';
import { appSessionsRoot } from '@/model';

const TALK_DESCRIPTION = `Send an message to another agent. Other agents communicate to you using this tool, you MUST communicate using this tool also; plain output is meaningless and NOT delivered to anyone. Delivery is asynchronous: your turn continues immediately, and any reply arrives later as another talk to you. If you want to wait for reply, simply stop after talking without further tool calls; any incoming talks will wake you up when you have stopped.`;

const WORKING_STYLE = `You are an AI agent working with autonomy. You complete your tasks with high quality, and communicate with other agents smartly.`;

/** Heading of every per-LLM-call reminder message. */
const REMINDER_TAG = 'system-reminder';

const fmt = new Intl.DateTimeFormat('en-US', {
	day: 'numeric',
	month: 'short',
	year: 'numeric',
});

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

/**
 * Internal reminder contributors (the topic file and the talkable-agent
 * roster): two subscriptions on the system-reminder event, each with its own
 * timing (a re-append interval) and content dedup. The topic file is watched
 * — its content is cached whenever the watcher fires — and the manifest is
 * built from the in-memory roster on demand. Lifecycle follows the owning
 * session.
 */
class InternalReminders {
	/** Minimum time between two appends of one contributor. */
	private static readonly INTERVAL_MS = 120_000;
	private readonly at: Record<Which, number | undefined> = {
		talkables: undefined,
		topic: undefined,
	};
	private readonly last: Record<Which, string | undefined> = {
		talkables: undefined,
		topic: undefined,
	};
	private watcher: FSWatcher | undefined;
	private topicContent = '';

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly kernel: Kernel,
		private readonly sessionId: () => string | undefined,
	) {
		this.pi.events.on(SYSTEM_REMINDER_CHANNEL, (data) => {
			this.append(data, 'topic');
		});
		this.pi.events.on(SYSTEM_REMINDER_CHANNEL, (data) => {
			this.append(data, 'talkables');
		});
	}

	/** Point the topic contributor at a file; re-binding swaps the watcher. */
	async setTopic(topic: string | undefined): Promise<void> {
		this.watcher?.close();
		this.watcher = undefined;
		this.topicContent = '';
		if (topic === undefined) return;
		await this.readTopic(topic);
		if (!existsSync(topic)) return;
		this.watcher = watch(topic, { persistent: false }, () => {
			void this.readTopic(topic);
		});
	}

	/** Read the topic file into the cache; a failed read empties it. */
	private async readTopic(topic: string): Promise<void> {
		try {
			this.topicContent = await Bun.file(topic).text();
		} catch {
			this.topicContent = '';
		}
	}

	/** One contributor's current block. */
	private block(which: Which): string {
		if (which === 'topic')
			return this.topicContent.trim() === '' ? '' : `<topic>\n${this.topicContent}\n</topic>`;
		const sessionId = this.sessionId();
		if (sessionId === undefined) return '';
		const entries = this.kernel.talkableFor(sessionId);
		return entries.length === 0
			? ''
			: `<talkable-agents>\n${entries.join('\n')}\n</talkable-agents>`;
	}

	/** Append one block, gated by this contributor's interval and dedup. */
	private append(data: unknown, which: Which): void {
		const now = Date.now();
		const at = this.at[which];
		if (at !== undefined && now - at < InternalReminders.INTERVAL_MS) return;
		const block = this.block(which);
		if (block === '') return;
		if (block === this.last[which]) return;
		this.at[which] = now;
		this.last[which] = block;
		const payload = data as SystemReminderEvent;
		payload.text = payload.text ? `${payload.text}\n\n${block}` : block;
	}
}

type Which = 'talkables' | 'topic';

/**
 * One instance per agent session (the interactive one that runs the viewed
 * agent natively, and every background SDK session). Owns everything
 * session-local: identity binding, the agent definition application, prompt
 * construction, the talk tool, talk delivery into this session, and the
 * talkable-info event. Background live sessions attach here so the viewed
 * and background cases keep no abstraction difference.
 */
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
	/** Internal reminder contributors; lifecycle follows this session. */
	private readonly reminders: InternalReminders;
	/** Background SDK session handle; the viewed session runs natively instead. */
	live: LiveSession | undefined;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly kernel: Kernel,
	) {
		// Factory time: pi re-runs this for every session's runner, before the
		// TUI renders history on a switch — the surface must exist by then.
		this.kernel.registerSurface(pi);
		this.registerTalkTool();
		this.reminders = new InternalReminders(pi, kernel, () => this.sessionId);
		pi.on('session_start', (_, ctx) => this.start(ctx));
		pi.on('before_agent_start', (_, ctx) => this.beginTurn(ctx));
		pi.on('context', (event) => this.remind(event));
		pi.on('input', (event, ctx) => this.leaderInput(event, ctx));
	}

	/** Bind this session's identity and apply the agent definition. */
	private async start(ctx: ExtensionContext): Promise<void> {
		await this.kernel.loadConfigs(ctx.cwd, ctx.isProjectTrusted());
		this.piFile = ctx.sessionManager.getSessionFile();
		const piSessionId = ctx.sessionManager.getSessionId();
		if (ctx.hasUI) {
			// Controller flavor: this instance drives the interactive session.
			// Re-attaches on every session (a resumed /apps session included).
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
				// Fresh session file: arm the pending (or default) agent provisionally;
				// Registered on the first user message.
				if (this.kernel.pendingAgent() === undefined)
					this.kernel.armPending((await this.kernel.defaultAgent()) ?? '');
				this.agent = this.kernel.pendingAgent() ?? '';
				this.registered = false;
				this.sessionId = undefined;
				if (this.agent !== '') {
					// A new app session begins here if none is active.
					if (this.kernel.appFolder() === undefined)
						await this.kernel.beginAppSession(appSessionsRoot(ctx.cwd));
					// Locate the fresh session's record inside the app session before
					// Its first turn; pi allocated the file in the default sessions dir.
					const record = this.kernel.provisionPending(this.agent);
					relocateRecord(
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
				await this.reminders.setTopic(found.topic);
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
			await this.reminders.setTopic(binding.topic);
			this.kernel.bindSession(binding.sessionId, this);
		}
		// Re-apply on agent change: the controller's session instance is shared
		// Across shifts, so the previous agent's tool activations must be replaced.
		// Same-agent re-fires (e.g. adoption) are no-ops.
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
		await this.reminders.setTopic(binding.topic);
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

	/** The system prompt: identity, instructions, skills. */
	private async beginTurn(ctx: ExtensionContext): Promise<{ systemPrompt: string } | undefined> {
		if (this.agent === '') return undefined; // Pi-native turn
		await this.ensureRegistered(ctx);
		if (!this.registered) return undefined; // Not persisted: Pi-native turn
		return { systemPrompt: this.buildPrompt(ctx.getSystemPrompt()) };
	}

	private buildPrompt(piPrompt: string): string {
		const identity = [
			`Application session: \`${this.appFolder ?? ''}\``,
			`Your ID: \`${this.sessionId ?? ''}\``,
			`Current date: ${fmt.format(new Date())}`,
			...(this.topic === undefined ? [] : [`Topic: \`${this.topic}\``]),
		].join('\n');
		const instructions = [WORKING_STYLE, ...(this.kernel.get(this.agent)?.prompts ?? [])].join(
			'\n\n',
		);
		// Lift the `<available_skills>` block out of pi's system prompt.
		const skills = /<available_skills>[\s\S]*?<\/available_skills>/u.exec(piPrompt)?.[0];
		return [
			`<meta>\n${identity}\n</meta>`,
			`<instructions>\n${instructions}\n</instructions>`,
			...(skills === undefined
				? []
				: [`<skills>\nUse \`read\` tool to use skills.\n${skills}\n</skills>`]),
		].join('\n\n');
	}

	/** Reminder injection: a transient user message before every LLM call.
	 * The content is assembled entirely through the system-reminder event —
	 * the session fires it with an empty payload, internal contributors and
	 * extensions append, non-empty content is wrapped and injected. Never
	 * persisted. */
	private remind(event: ContextEvent): { messages?: ContextEvent['messages'] } {
		if (this.agent === '' || !this.registered) return {}; // Pi-native turn
		const payload: SystemReminderEvent = { text: '' };
		this.pi.events.emit(SYSTEM_REMINDER_CHANNEL, payload);
		const content = payload.text.trim();
		if (!content) return {};
		return {
			messages: [
				...event.messages,
				{
					content: [
						{
							text: `<${REMINDER_TAG}>\n${content}\n</${REMINDER_TAG}>`,
							type: 'text' as const,
						},
					],
					role: 'user' as const,
					timestamp: Date.now(),
				},
			],
		};
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
				/** Show the sent message in the tool result — the human sees
				 * what was said, once per talk, instead of a replaceable
				 * status notification. */
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

	/** Deliver a talk into this session: background sessions through their
	 * live handle (steered mid-generation, prompted when idle), the viewed
	 * session through the controller's own conversation. */
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

	/** The session's talkable manifest content, dispatched on this session's
	 * own event bus; handlers must mutate synchronously. */
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

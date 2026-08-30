/**
 * Prompt module: the single prompt construction site. Sections are tiered:
 * `system` sections render into the per-run system prompt, `turn` and
 * `conditional` sections into the transient reminder message the host
 * adapter appends before every LLM call (see ./bootstrap.ts). Every render
 * is scoped to one agent — sections may declare the agents they target.
 * Other modules register sections (Sessions: identity, topic, note,
 * talkable agents; Agents: instructions); the skills section is lifted from
 * pi's own system prompt (which builds `<available_skills>` from the real
 * resource loader).
 */
import type { TalkableSession } from '@/model';

export type PromptContext = {
	now: Date;
	/** Previous LLM call time; omitted before the first call. */
	lastInvocation?: Date;
	sessionId: string;
	agent: string;
	appFolder: string;
	topicPath?: string;
	/** The agent's tool set includes a note-editing tool. */
	canEditNote: boolean;
	/** Pi's current system prompt for this session (source of the skills list). */
	systemPrompt: string;
};

/** Where a section renders: the system prompt or the reminder message. */
export type PromptTier = 'system' | 'turn' | 'conditional' | 'periodic';

export type PromptSection = {
	tier: PromptTier;
	/** Order within the tier; registration order breaks ties. */
	priority: number;
	/** Render only for these agents; omitted = every agent. */
	agents?: ReadonlyArray<string>;
	title?: string;
	/** Section body; returning undefined or '' skips the section. */
	render: (ctx: PromptContext) => string | undefined | Promise<string | undefined>;
};

function skillsSection(ctx: PromptContext): string | undefined {
	// Lift the `<available_skills>` block out of pi's system prompt.
	const skillXml = /<available_skills>[\s\S]*?<\/available_skills>/u.exec(ctx.systemPrompt)?.[0];
	if (skillXml) return `Use \`read\` tool to use skills.\n\n${skillXml}`;
}

/** Render one talkable session as a prompt entry. */
export function talkableEntry(s: TalkableSession): string {
	return `### \`${s.id}\`\n\n- Agent: ${s.agent}\n- Relationship: ${s.relationship}${s.recordPath ? `\n- Footage: \`${s.recordPath}\`` : ''}${s.note ? `\n- Note:\n\n${s.note}` : ''}`;
}

export default class Prompt {
	private readonly sections: Array<PromptSection> = [];

	private readonly register = (section: PromptSection): void => {
		this.sections.push(section);
	};

	/** One tier's sections for one agent, priority-ordered. */
	private readonly tierFor = (tier: PromptTier, agent: string): Array<PromptSection> =>
		this.sections
			.filter((s) => s.tier === tier && (s.agents === undefined || s.agents.includes(agent)))
			.toSorted((a, b) => a.priority - b.priority);

	private readonly renderTier = async (tier: PromptTier, ctx: PromptContext): Promise<string> => {
		const parts: Array<string> = [];
		for (const { render, title } of this.tierFor(tier, ctx.agent)) {
			const body = (await render(ctx))?.trim();
			if (!body) continue;
			parts.push(title ? `## ${title}\n\n${body}` : body);
		}
		return parts.join('\n\n');
	};

	constructor() {
		this.register({ priority: 9000, render: skillsSection, tier: 'system', title: 'Skills' });
	}

	root = {
		registerSection: this.register,
		/** The agent's reminder message body — the `turn` or `conditional` tier. */
		reminder: (ctx: PromptContext, tier: 'turn' | 'conditional' | 'periodic') =>
			this.renderTier(tier, ctx),
		/** The agent's system prompt — the `system` tier. */
		render: (ctx: PromptContext) => this.renderTier('system', ctx),
	};
}

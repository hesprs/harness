/**
 * Prompt module: the single system-prompt construction site. Other modules
 * register priority-ordered sections (Sessions: identity, topic, note,
 * talkable agents; Agents: instructions); the host adapter renders them per
 * agent invocation. The skills section is lifted from pi's own system prompt
 * (which builds `<available_skills>` from the real resource loader).
 */
import type { TalkableSession } from '@/model';

export type PromptContext = {
	now: Date;
	/** Previous invocation time; omitted on the first turn. */
	lastInvocation?: Date;
	cwd: string;
	sessionId: string;
	agent: string;
	appFolder: string;
	topicPath?: string;
	/** The agent's tool set includes a note-editing tool. */
	canEditNote: boolean;
	/** Pi's current system prompt for this session (source of the skills list). */
	systemPrompt: string;
};

export type PromptSection = {
	priority: number;
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

	private readonly render = async (ctx: PromptContext): Promise<string> => {
		const ordered = [...this.sections].sort((a, b) => a.priority - b.priority);
		const parts: Array<string> = [];
		for (const { render, title } of ordered) {
			const body = (await render(ctx))?.trim();
			if (!body) continue;
			parts.push(title ? body : `## ${title}\n\n${body.trim()}`);
		}
		return parts.join('\n\n');
	};

	constructor() {
		this.register({ priority: 9000, render: skillsSection, title: 'Skills' });
	}

	root = {
		registerSection: this.register,
		render: this.render,
	};
}

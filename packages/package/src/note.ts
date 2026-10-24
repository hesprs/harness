import { kernel, TALKABLE_INFO_CHANNEL } from '@repo/shared/contract';
import { join } from 'node:path';
import type { Extension, TalkableInfoEvent } from '@repo/shared/contract';

/**
 * The personal note: a per-session markdown file inside the application session folder. Its path
 * goes into a persisted system prompt section (reminding this agent) and into its talkable-info
 * event (manifesting this session to other agents). The content is cached at `before_agent_start`
 * time; the talkable-info handler mutates synchronously using the cache.
 */
const personalNote: Extension = (pi) => {
	let notePath: string | undefined;
	/** Cached note content, refreshed at the start of each turn. */
	let note = '';

	const resolve = (ctx: {
		sessionManager: { getSessionId: () => string };
	}): string | undefined => {
		const binding = kernel().bindingOf(ctx.sessionManager.getSessionId());
		return binding === undefined
			? undefined
			: join(binding.appFolder, `${binding.sessionId}.md`);
	};

	pi.on('before_agent_start', async (event, ctx) => {
		notePath ??= resolve(ctx);
		if (notePath === undefined) return;
		const file = Bun.file(notePath);
		if (!(await file.exists())) await Bun.write(notePath, '');
		note = await Bun.file(notePath).text();
		const canEdit = pi
			.getActiveTools()
			.some((tool) => tool === 'write' || tool === 'edit' || tool === 'apply_patch');
		event.systemPromptOptions.sections['personal-note'] =
			`Your personal note is at \`${notePath}\`.${canEdit ? ' You can edit this note with your file tools; use it for TODOs; the note manifests what you are doing to other agents.' : ''}`;
	});

	// The talkable-info event: append the cached note to this session's Talkable manifest content, so other agents see what this agent is Doing. Same synchronous-mutation constraint.
	pi.events.on(TALKABLE_INFO_CHANNEL, (data) => {
		if (!note.trim()) return;
		const payload = data as TalkableInfoEvent;
		payload.text = payload.text ? `${payload.text}\n\n${note}` : note;
	});
};

export default personalNote;

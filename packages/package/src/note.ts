import type { Extension, SystemReminderEvent, TalkableInfoEvent } from '@repo/shared/contract';
import { kernel, SYSTEM_REMINDER_CHANNEL, TALKABLE_INFO_CHANNEL } from '@repo/shared/contract';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The personal note: a per-session markdown file inside the application
 * session folder. Its path goes into the system prompt, its content into
 * this session's system-reminder event (reminding this agent) and into its
 * talkable-info event (manifesting this session to other agents). The
 * content is cached (refreshed every turn) because both event handlers must
 * mutate synchronously — no file IO in the dispatch path.
 */
const personalNote: Extension = (pi) => {
	let notePath: string | undefined;
	/** Cached note content, refreshed whenever a turn begins. */
	let note = '';

	const resolve = (ctx: {
		sessionManager: { getSessionId: () => string };
	}): string | undefined => {
		const binding = kernel().bindingOf(ctx.sessionManager.getSessionId());
		return binding === undefined
			? undefined
			: join(binding.appFolder, `${binding.sessionId}.md`);
	};

	pi.on('before_agent_start', (_event, ctx) => {
		notePath ??= resolve(ctx);
		if (notePath === undefined) return;
		if (!existsSync(notePath)) writeFileSync(notePath, '');
		note = readFileSync(notePath, 'utf8');
		const canEdit = pi
			.getActiveTools()
			.some((tool) => tool === 'write' || tool === 'edit' || tool === 'apply_patch');
		const section = `<personal-note>\nYour personal note is at \`${notePath}\`.${canEdit ? ' You can edit this note with your file tools; use it for TODOs; the note manifests what you are doing to other agents.' : ''}\n</personal-note>`;
		return { systemPrompt: `${ctx.getSystemPrompt()}\n\n${section}` };
	});

	pi.on('context', (_event, ctx) => {
		// Refresh the cache each turn.
		notePath ??= resolve(ctx);
		if (notePath !== undefined && existsSync(notePath)) note = readFileSync(notePath, 'utf8');
		return {};
	});

	// The per-turn system reminder: append the cached note, reminding this
	// Agent of what it is doing. Handlers must append synchronously (the
	// Session reads the payload right after emit), hence no IO here.
	pi.events.on(SYSTEM_REMINDER_CHANNEL, (data) => {
		if (!note.trim()) return;
		const payload = data as SystemReminderEvent;
		payload.text = payload.text ? `${payload.text}\n\n${note}` : note;
	});

	// The talkable-info event: append the cached note to this session's
	// Talkable manifest content, so other agents see what this agent is
	// Doing. Same synchronous-mutation constraint.
	pi.events.on(TALKABLE_INFO_CHANNEL, (data) => {
		if (!note.trim()) return;
		const payload = data as TalkableInfoEvent;
		payload.text = payload.text ? `${payload.text}\n\n${note}` : note;
	});
};

export default personalNote;

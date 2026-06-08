export type ContextFile = {
	path: string;
	lineCount: number;
	lineNumbers?: Array<number>;
	lastReadAt: number;
};

export type RememberedTaskSession = {
	alias: string;
	taskId: string;
	agentType: string;
	label: string;
	contextFiles: Array<ContextFile>;
	createdAt: number;
	lastUsedAt: number;
};

type SessionGroupMap = Map<string, Array<RememberedTaskSession>>;

const MIN_CONTEXT_FILE_LINES = 10;
const MAX_CONTEXT_FILES_PER_SESSION = 8;

type SessionManagerOptions = {
	readContextMinLines?: number;
	readContextMaxFiles?: number;
};

function aliasPrefix(agentType: string): string {
	const normalized = agentType.toLowerCase().replace(/[^a-z0-9]/g, '');

	if (normalized.length >= 3) return normalized.slice(0, 3);

	if (normalized.length > 0) return normalized.padEnd(3, 'x');

	return 'gen';
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function eligibleContextFiles(files: Array<ContextFile>, minLines: number): Array<ContextFile> {
	return files
		.filter((file) => file.lineCount >= minLines)
		.sort((a, b) => b.lastReadAt - a.lastReadAt);
}

export function deriveTaskSessionLabel(input: {
	description?: string;
	prompt?: string;
	agentType: string;
}): string {
	const preferred = normalizeWhitespace(input.description ?? '');

	if (preferred) return preferred.slice(0, 48);

	const firstPromptLine = (input.prompt ?? '')
		.split(/\r?\n/)
		.map((line) => normalizeWhitespace(line))
		.find(Boolean);

	if (firstPromptLine) return firstPromptLine.slice(0, 48);

	return `recent ${input.agentType} task`;
}

export class SessionManager {
	private readonly readContextMinLines: number;
	private readonly readContextMaxFiles: number;
	private readonly sessionsByParent = new Map<string, SessionGroupMap>();
	private readonly nextAliasIndexByParent = new Map<string, Map<string, number>>();
	private orderCounter = 0;

	constructor(
		private readonly maxSessionsPerAgent: number,
		options: SessionManagerOptions = {},
	) {
		this.readContextMinLines = options.readContextMinLines ?? MIN_CONTEXT_FILE_LINES;
		this.readContextMaxFiles = options.readContextMaxFiles ?? MAX_CONTEXT_FILES_PER_SESSION;
	}

	remember(input: {
		parentSessionId: string;
		taskId: string;
		agentType: string;
		label: string;
	}): RememberedTaskSession {
		const now = this.nextOrder();
		const group = this.getAgentGroup(input.parentSessionId, input.agentType, true);

		if (!group) throw new Error('Failed to initialize session group');

		const existing = group.find((entry) => entry.taskId === input.taskId);

		if (existing) {
			existing.label = input.label;
			existing.lastUsedAt = this.nextOrder();
			return existing;
		}

		const remembered: RememberedTaskSession = {
			agentType: input.agentType,
			alias: this.nextAlias(input.parentSessionId, input.agentType),
			contextFiles: [],
			createdAt: now,
			label: input.label,
			lastUsedAt: now,
			taskId: input.taskId,
		};

		group.push(remembered);
		this.trimGroup(group);
		return remembered;
	}

	markUsed(parentSessionId: string, agentType: string, key: string): void {
		const group = this.getAgentGroup(parentSessionId, agentType, false);
		const match = group?.find((entry) => entry.alias === key || entry.taskId === key);

		if (match) match.lastUsedAt = this.nextOrder();
	}

	resolve(parentSessionId: string, agentType: string, key: string) {
		const group = this.getAgentGroup(parentSessionId, agentType, false);
		const match = group?.find((entry) => entry.alias === key || entry.taskId === key);

		return match;
	}

	drop(parentSessionId: string, agentType: string, key: string): void {
		const group = this.getAgentGroup(parentSessionId, agentType, false);

		if (!group) return;

		const next = group.filter((entry) => entry.alias !== key && entry.taskId !== key);
		this.setAgentGroup(parentSessionId, agentType, next);
	}

	dropTask(taskId: string): void {
		let removed = 0;

		for (const [parentSessionId, groups] of this.sessionsByParent.entries())
			for (const [agentType, group] of groups.entries()) {
				const before = group.length;
				const next = group.filter((entry) => entry.taskId !== taskId);
				removed += before - next.length;
				this.setAgentGroup(parentSessionId, agentType, next);
			}
	}

	taskIds(): Set<string> {
		const ids = new Set<string>();

		for (const groups of this.sessionsByParent.values())
			for (const group of groups.values()) for (const entry of group) ids.add(entry.taskId);

		return ids;
	}

	addContext(taskId: string, files: Array<ContextFile>): void {
		if (files.length === 0) return;

		for (const groups of this.sessionsByParent.values())
			for (const group of groups.values()) {
				const match = group.find((entry) => entry.taskId === taskId);

				if (!match) continue;

				const existing = new Map(match.contextFiles.map((file) => [file.path, file]));

				for (const file of files) {
					const previous = existing.get(file.path);

					if (previous) {
						previous.lineCount = Math.max(previous.lineCount, file.lineCount);
						previous.lastReadAt = Math.max(previous.lastReadAt, file.lastReadAt);
						continue;
					}

					match.contextFiles.push({ ...file });
				}

				this.trimContextFiles(match);
			}
	}

	clearParent(parentSessionId: string): void {
		this.sessionsByParent.delete(parentSessionId);
		this.nextAliasIndexByParent.delete(parentSessionId);
	}

	formatForPrompt(parentSessionId: string): string | undefined {
		const groups = this.sessionsByParent.get(parentSessionId);

		if (!groups || groups.size === 0) return undefined;

		const lines = [...groups.entries()]
			.map(
				([agentType, entries]) =>
					[agentType, [...entries].sort((a, b) => b.lastUsedAt - a.lastUsedAt)] as const,
			)
			.filter(([, entries]) => entries.length > 0)
			.sort((a, b) => {
				const aLastUsedAt = a[1][0]?.lastUsedAt ?? 0;
				const bLastUsedAt = b[1][0]?.lastUsedAt ?? 0;
				return bLastUsedAt - aLastUsedAt;
			})
			.map(([agentType, entries]) =>
				[
					`- ${agentType}: ${entries
						.map((entry) => `${entry.alias} ${entry.label}`)
						.join('; ')}`,
					...entries
						.map(
							(entry) =>
								[
									entry,
									formatContextFiles(entry.contextFiles, {
										maxFiles: this.readContextMaxFiles,
										minLines: this.readContextMinLines,
									}),
								] as const,
						)
						.filter(([, context]) => context.length > 0)
						.map(([entry, context]) => `  Context read by ${entry.alias}: ${context}`),
				].join('\n'),
			);

		if (lines.length === 0) return undefined;

		return [
			'### Resumable Sessions',
			'Reuse only for clear continuation of the same thread. Otherwise start fresh.',
			'',
			...lines,
		].join('\n');
	}

	private getAgentGroup(
		parentSessionId: string,
		agentType: string,
		create: boolean,
	): Array<RememberedTaskSession> | undefined {
		let groups = this.sessionsByParent.get(parentSessionId);

		if (!groups && create) {
			groups = new Map();
			this.sessionsByParent.set(parentSessionId, groups);
		}

		let group = groups?.get(agentType);

		if (!group && create && groups) {
			group = [];
			groups.set(agentType, group);
		}

		return group;
	}

	private setAgentGroup(
		parentSessionId: string,
		agentType: string,
		entries: Array<RememberedTaskSession>,
	): void {
		const groups = this.sessionsByParent.get(parentSessionId);

		if (!groups) return;

		if (entries.length === 0) {
			groups.delete(agentType);

			if (groups.size === 0) {
				this.sessionsByParent.delete(parentSessionId);
				this.nextAliasIndexByParent.delete(parentSessionId);
			}

			return;
		}

		groups.set(agentType, entries);
	}

	private nextAlias(parentSessionId: string, agentType: string): string {
		let counters = this.nextAliasIndexByParent.get(parentSessionId);

		if (!counters) {
			counters = new Map();
			this.nextAliasIndexByParent.set(parentSessionId, counters);
		}

		const next = (counters.get(agentType) ?? 0) + 1;
		counters.set(agentType, next);
		return `${aliasPrefix(agentType)}-${next}`;
	}

	private trimGroup(group: Array<RememberedTaskSession>): void {
		group.sort((a, b) => b.lastUsedAt - a.lastUsedAt);

		if (group.length > this.maxSessionsPerAgent) group.length = this.maxSessionsPerAgent;
	}

	private trimContextFiles(entry: RememberedTaskSession): void {
		if (this.readContextMaxFiles === 0) {
			entry.contextFiles = [];
			return;
		}

		entry.contextFiles = eligibleContextFiles(
			entry.contextFiles,
			this.readContextMinLines,
		).slice(0, this.readContextMaxFiles + 1);
	}

	private nextOrder(): number {
		this.orderCounter += 1;
		return this.orderCounter;
	}
}

function formatContextFiles(
	files: Array<ContextFile>,
	options: { minLines: number; maxFiles: number },
): string {
	const eligible = eligibleContextFiles(files, options.minLines);
	const shown = eligible.slice(0, options.maxFiles);
	const rest = eligible.length - shown.length;
	const rendered = shown.map((file) => `${file.path} (${file.lineCount} lines)`);
	return `${rendered.join(', ')}${rest > 0 ? ` (+${rest} more)` : ''}`;
}

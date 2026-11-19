// oxlint-disable max-lines
import { defineTool } from '@earendil-works/pi-coding-agent';
import { errText, text } from '@repo/shared/text';
/**
 * Apply_patch: Codex-style patch envelopes (Add/Update/Delete/Move) applied to the filesystem.
 * Ported from code-yeongyu/pi-apply-patch (parser, chunk seeking with fuzzy fallback, recovery
 * instructions); TUI preview omitted. Deviations from upstream: @@ chunks match anywhere in the
 * file instead of only forward of the previous chunk, and every applicable hunk is applied before
 * one aggregate error names the failed and the applied actions.
 */
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Type } from 'typebox';

export type PatchResult = { summary: string };

export type ApplyPatchFailure = {
	code?: string;
	filePath: string;
	message: string;
	operation: 'add' | 'delete' | 'update';
};

type ParsedPatch =
	| { type: 'add'; filePath: string; content: string }
	| { type: 'delete'; filePath: string }
	| { type: 'update'; filePath: string; movePath?: string; chunks: Array<PatchChunk> };

type PatchChunk = {
	changeContexts: Array<string>;
	oldLines: Array<string>;
	newLines: Array<string>;
	isEndOfFile: boolean;
};

export class PatchParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PatchParseError';
	}
}

export class PatchApplicationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PatchApplicationError';
	}
}

/** One patch's outcome after every applicable hunk was applied: the failures, plus what landed. */
export class ApplyPatchError extends Error {
	readonly appliedSummaries: Array<string>;
	readonly failures: Array<ApplyPatchFailure>;
	readonly total: number;

	constructor(
		failures: Array<ApplyPatchFailure>,
		appliedSummaries: Array<string>,
		appliedFiles: Array<string>,
		total: number,
	) {
		super(failureMessage(failures, appliedSummaries, appliedFiles, total));
		this.name = 'ApplyPatchError';
		this.appliedSummaries = appliedSummaries;
		this.failures = failures;
		this.total = total;
	}
}

/** Aggregate failure text: what failed, upstream's recovery wording, and what still applied. */
function failureMessage(
	failures: Array<ApplyPatchFailure>,
	appliedSummaries: Array<string>,
	appliedFiles: Array<string>,
	total: number,
): string {
	// Upstream pi-apply-patch: failures without a filesystem error code are context mismatches; a
	// Reread fixes those, not ENOENT/EACCES, and applied files must not be reread.
	const mustReadFiles = [
		...new Set(
			failures
				.filter((failure) => failure.code === undefined)
				.map((failure) => failure.filePath),
		),
	];
	const lines: Array<string> = [
		`apply_patch failed: ${failures.length} of ${total} file actions failed.`,
		'Failed:',
		...failures.map(
			(failure) => `- ${failure.filePath} (${failure.operation}): ${failure.message}`,
		),
	];
	if (mustReadFiles.length > 0)
		lines.push(`Recovery: MUST read ${mustReadFiles.join(' and ')} before retrying.`);
	if (appliedSummaries.length > 0)
		lines.push('Applied:', ...appliedSummaries.map((summary) => `- ${summary}`));
	const mustRead = new Set(mustReadFiles);
	if (appliedFiles.some((filePath) => !mustRead.has(filePath)))
		lines.push(
			'Recovery: MUST NOT reread other files from this patch unless a specific dependency requires it.',
		);
	return lines.join('\n');
}

function fsErrorCode(error: unknown): string | undefined {
	if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
		return error.code;

	return undefined;
}

function normalizePatchText(patchText: string): string {
	return patchText.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

function stripHeredoc(input: string): string {
	const heredocMatch =
		/^(?:cat\s+)?<<['"]?(?<tag>\w+)['"]?\s*\n(?<body>[\s\S]*?)\n\k<tag>\s*$/u.exec(input);
	if (heredocMatch) return heredocMatch.groups?.body ?? input;

	return input;
}

function normalizeSeekLine(line: string): string {
	return line
		.trim()
		.replaceAll(/[‐‑‒–—―−]/gu, '-')
		.replaceAll(/[‘’‚‛]/gu, "'")
		.replaceAll(/[“”„‟]/gu, '"')
		.replaceAll(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/gu, ' ');
}

function matchesAt(
	lines: Array<string>,
	pattern: Array<string>,
	index: number,
	compare: (left: string, right: string) => boolean,
): boolean {
	for (let patternIndex = 0; patternIndex < pattern.length; patternIndex++) {
		const line = lines[index + patternIndex];
		const expected = pattern[patternIndex];
		if (line === undefined || expected === undefined || !compare(line, expected)) return false;
	}
	return true;
}

function seekSequence(
	lines: Array<string>,
	pattern: Array<string>,
	start: number,
	eof: boolean,
): { index: number; fuzz: 0 | 1 | 100 | 10_000 } | undefined {
	if (pattern.length === 0) return { fuzz: 0, index: start };

	if (pattern.length > lines.length) return undefined;

	const searchStart =
		eof && lines.length >= pattern.length ? lines.length - pattern.length : start;
	const lastStart = lines.length - pattern.length;
	for (let index = searchStart; index <= lastStart; index++)
		if (matchesAt(lines, pattern, index, (line, expected) => line === expected))
			return { fuzz: 0, index };

	const linesTrimEnd = lines.map((line) => line.trimEnd());
	const patternTrimEnd = pattern.map((line) => line.trimEnd());
	for (let index = searchStart; index <= lastStart; index++)
		if (matchesAt(linesTrimEnd, patternTrimEnd, index, (line, expected) => line === expected))
			return { fuzz: 1, index };

	const linesTrim = lines.map((line) => line.trim());
	const patternTrim = pattern.map((line) => line.trim());
	for (let index = searchStart; index <= lastStart; index++)
		if (matchesAt(linesTrim, patternTrim, index, (line, expected) => line === expected))
			return { fuzz: 100, index };

	const linesNormalized = lines.map(normalizeSeekLine);
	const patternNormalized = pattern.map(normalizeSeekLine);
	for (let index = searchStart; index <= lastStart; index++)
		if (
			matchesAt(
				linesNormalized,
				patternNormalized,
				index,
				(line, expected) => line === expected,
			)
		)
			return { fuzz: 10_000, index };

	return undefined;
}

function parsePatch(patchText: string): Array<ParsedPatch> {
	const normalized = stripHeredoc(normalizePatchText(patchText).trim()).trim();
	const lines = normalized.split('\n');
	const beginIndex = lines[0]?.trim() === '*** Begin Patch' ? 0 : -1;
	const lastLine = lines.at(-1);
	const endIndex = lastLine?.trim() === '*** End Patch' ? lines.length - 1 : -1;
	if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex)
		throw new PatchParseError(
			'Invalid patch format: expected *** Begin Patch ... *** End Patch envelope',
		);

	const hunks: Array<ParsedPatch> = [];
	let index = beginIndex + 1;
	while (index < endIndex) {
		const line = lines[index] ?? '';
		if (!line.startsWith('*** ')) {
			index++;
			continue;
		}

		if (line.startsWith('*** Add File: ')) {
			const filePath = line.slice(14);
			index++;
			const contentLines: Array<string> = [];
			while (index < endIndex) {
				const nextLine = lines[index] ?? '';
				if (nextLine.startsWith('*** ')) break;
				if (!nextLine.startsWith('+'))
					throw new PatchParseError(
						"Invalid patch format: Add File lines must start with '+'",
					);

				contentLines.push(nextLine.slice(1));
				index++;
			}
			hunks.push({
				content: contentLines.length === 0 ? '' : `${contentLines.join('\n')}\n`,
				filePath,
				type: 'add',
			});
			continue;
		}

		if (line.startsWith('*** Delete File: ')) {
			hunks.push({ filePath: line.slice(17), type: 'delete' });
			index++;
			continue;
		}

		if (line.startsWith('*** Update File: ')) {
			const filePath = line.slice(17);
			index++;
			let movePath: string | undefined;
			if ((lines[index] ?? '').startsWith('*** Move to: ')) {
				movePath = (lines[index] ?? '').slice(13);
				index++;
			}

			const chunks: Array<PatchChunk> = [];
			while (index < endIndex) {
				const nextLine = lines[index] ?? '';
				if (nextLine.trim() === '') {
					index++;
					continue;
				}
				if (nextLine.startsWith('*** ')) break;

				const allowMissingContext = chunks.length === 0;
				const changeContexts: Array<string> = [];
				if (nextLine.startsWith('@@'))
					while (index < endIndex) {
						const contextLine = lines[index] ?? '';
						if (contextLine === '@@') {
							index++;
							continue;
						}
						if (contextLine.startsWith('@@ ')) {
							changeContexts.push(contextLine.slice(3));
							index++;
							continue;
						}
						break;
					}
				else if (!allowMissingContext)
					throw new PatchParseError(
						`Expected update hunk to start with a @@ context marker, got: '${nextLine}'`,
					);

				const oldLines: Array<string> = [];
				const newLines: Array<string> = [];
				let isEndOfFile = false;
				let parsedLines = 0;
				while (index < endIndex) {
					const hunkLine = lines[index] ?? '';
					if (hunkLine === '*** End of File') {
						if (parsedLines === 0)
							throw new PatchParseError('Update hunk does not contain any lines');

						isEndOfFile = true;
						index++;
						break;
					}
					if (hunkLine.startsWith('@@') || hunkLine.startsWith('*** ')) break;
					const prefix = hunkLine[0];
					const value = hunkLine.slice(1);
					if (prefix === undefined) {
						oldLines.push('');
						newLines.push('');
					} else if (prefix === ' ') {
						oldLines.push(value);
						newLines.push(value);
					} else if (prefix === '-') oldLines.push(value);
					else if (prefix === '+') newLines.push(value);
					else if (parsedLines > 0) break;
					else
						throw new PatchParseError(
							`Unexpected line found in update hunk: '${hunkLine}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
						);

					parsedLines++;
					index++;
				}

				if (parsedLines === 0)
					throw new PatchParseError('Update hunk does not contain any lines');

				chunks.push({ changeContexts, isEndOfFile, newLines, oldLines });
			}
			if (chunks.length === 0 && !movePath)
				throw new PatchParseError(`Update file hunk for path '${filePath}' is empty`);

			hunks.push(
				movePath === undefined
					? { chunks, filePath, type: 'update' }
					: { chunks, filePath, movePath, type: 'update' },
			);
			continue;
		}

		throw new PatchParseError(
			`'${line}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
		);
	}

	return hunks;
}

function parseNonEmptyPatch(patchText: string): Array<ParsedPatch> {
	const hunks = parsePatch(patchText);
	if (hunks.length > 0) return hunks;

	const normalized = normalizePatchText(patchText).trim();
	if (normalized === '*** Begin Patch\n*** End Patch')
		throw new PatchParseError('patch rejected: empty patch');

	throw new PatchParseError('apply_patch verification failed: no hunks found');
}

function splitFileLines(content: string): Array<string> {
	const lines = normalizePatchText(content).split('\n');
	if (lines.at(-1) === '') lines.pop();

	return lines;
}

/**
 * Match every chunk anywhere in the file: each @@ group seeks from its own context markers (or the
 * top) over lines no earlier chunk has claimed, so chunk order in the patch does not matter.
 */
function replaceChunks(content: string, filePath: string, chunks: Array<PatchChunk>): string {
	const originalLines = splitFileLines(content);
	const replacements: Array<{ start: number; oldLength: number; newLines: Array<string> }> = [];
	const claimed: Array<{ end: number; start: number }> = [];

	for (const chunk of chunks) {
		let searchFrom = 0;
		for (const changeContext of chunk.changeContexts) {
			const contextMatch = seekSequence(originalLines, [changeContext], searchFrom, false);
			if (contextMatch === undefined)
				throw new PatchApplicationError(
					`Failed to find context '${changeContext}' in ${filePath}`,
				);

			searchFrom = contextMatch.index + 1;
		}

		if (chunk.oldLines.length === 0) {
			const insertionIndex =
				originalLines.at(-1) === '' ? originalLines.length - 1 : originalLines.length;
			replacements.push({ newLines: chunk.newLines, oldLength: 0, start: insertionIndex });
			continue;
		}

		let pattern = chunk.oldLines;
		let newLines = chunk.newLines;
		let foundAt = seekUnclaimed(originalLines, pattern, searchFrom, chunk.isEndOfFile, claimed);
		if (foundAt === undefined && pattern.at(-1) === '') {
			pattern = pattern.slice(0, -1);
			if (newLines.at(-1) === '') newLines = newLines.slice(0, -1);

			foundAt = seekUnclaimed(originalLines, pattern, searchFrom, chunk.isEndOfFile, claimed);
		}
		if (foundAt === undefined)
			throw new PatchApplicationError(
				`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join('\n')}`,
			);

		replacements.push({ newLines, oldLength: pattern.length, start: foundAt });
		claimed.push({ end: foundAt + pattern.length, start: foundAt });
	}

	const nextLines = [...originalLines];
	for (const replacement of replacements.sort((left, right) => right.start - left.start))
		nextLines.splice(replacement.start, replacement.oldLength, ...replacement.newLines);

	nextLines.push('');
	return nextLines.join('\n');
}

/** First match at or after `start` that does not overlap an already-claimed range. */
function seekUnclaimed(
	lines: Array<string>,
	pattern: Array<string>,
	start: number,
	eof: boolean,
	claimed: Array<{ end: number; start: number }>,
): number | undefined {
	let from = start;
	for (;;) {
		const found = seekSequence(lines, pattern, from, eof);
		if (found === undefined) return undefined;
		const end = found.index + pattern.length;
		if (!claimed.some((range) => found.index < range.end && range.start < end))
			return found.index;
		if (eof) return undefined; // Only the final position can match an end-of-file chunk
		from = found.index + 1;
	}
}

async function applySingleHunk(
	cwd: string,
	hunk: ParsedPatch,
): Promise<{ appliedFile: string; summary: string }> {
	const absolutePath = path.resolve(cwd, hunk.filePath);

	if (hunk.type === 'add') {
		await mkdir(path.dirname(absolutePath), { recursive: true });
		await Bun.write(absolutePath, hunk.content);
		return { appliedFile: hunk.filePath, summary: `add: ${hunk.filePath}` };
	}

	if (hunk.type === 'delete') {
		await stat(absolutePath);
		await rm(absolutePath);
		return { appliedFile: hunk.filePath, summary: `delete: ${hunk.filePath}` };
	}

	const absoluteMovePath =
		hunk.movePath === undefined ? undefined : path.resolve(cwd, hunk.movePath);
	const currentContent = await readFile(absolutePath, 'utf8');
	const nextContent =
		hunk.chunks.length === 0
			? currentContent
			: replaceChunks(currentContent, hunk.filePath, hunk.chunks);

	if (hunk.movePath !== undefined && absoluteMovePath !== undefined) {
		await mkdir(path.dirname(absoluteMovePath), { recursive: true });
		await Bun.write(absoluteMovePath, nextContent);
		if (absoluteMovePath !== absolutePath) await rm(absolutePath);

		return {
			appliedFile: hunk.movePath,
			summary: `move: ${hunk.filePath} -> ${hunk.movePath}`,
		};
	}

	await Bun.write(absolutePath, nextContent);
	return { appliedFile: hunk.filePath, summary: `update: ${hunk.filePath}` };
}

/**
 * Apply a patch body relative to `root`. Malformed patches throw before anything is applied; a hunk
 * that fails is recorded while every other hunk still lands, then one aggregate error names the
 * failed and the applied actions.
 */
export async function applyPatch(root: string, patch: string): Promise<PatchResult> {
	const hunks = parseNonEmptyPatch(patch);
	const summaries: Array<string> = [];
	const appliedFiles: Array<string> = [];
	const failures: Array<ApplyPatchFailure> = [];
	for (const hunk of hunks)
		try {
			const { appliedFile, summary } = await applySingleHunk(root, hunk);
			summaries.push(summary);
			appliedFiles.push(appliedFile);
		} catch (error) {
			failures.push({
				code: fsErrorCode(error),
				filePath: hunk.filePath,
				message: errText(error),
				operation: hunk.type,
			});
		}

	if (failures.length > 0)
		throw new ApplyPatchError(failures, summaries, appliedFiles, hunks.length);

	return { summary: summaries.join('\n') };
}

const FREEFORM_DESCRIPTION =
	'Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.';
const LARK_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;

// The `apply_patch` tool: registered by `toolFile` (index.ts), active only for GPT models.
export const applyPatchTool = defineTool({
	constrainedSampling: { type: 'grammar', variants: { openai_lark: LARK_GRAMMAR } },
	description: FREEFORM_DESCRIPTION,
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		try {
			const result = await applyPatch(ctx.cwd, params.input);
			return { ...text(result.summary), structuredContent: result };
		} catch (error) {
			if (error instanceof ApplyPatchError)
				return {
					...text(error.message, true),
					structuredContent: {
						failures: error.failures,
						summary: error.appliedSummaries.join('\n'),
					},
				};

			return text(`apply_patch failed: ${errText(error)}`, true);
		}
	},
	label: 'ApplyPatch',
	name: 'apply_patch',
	outputSchema: Type.Object({
		failures: Type.Optional(
			Type.Array(
				Type.Object({
					code: Type.Optional(
						Type.String({
							description: 'Filesystem error code; absent for context mismatches',
						}),
					),
					filePath: Type.String({ description: 'File the failed action targeted' }),
					message: Type.String({ description: 'Why the action failed' }),
					operation: Type.String({
						description: 'Failed action: add, delete, or update',
					}),
				}),
				{ description: 'Failed file actions; absent when the whole patch applied' },
			),
		),
		summary: Type.String({
			description:
				'Per-file operation summary (add/delete/update/move) of the applied actions',
		}),
	}),
	parameters: Type.Object({
		input: Type.String({ description: 'The entire apply_patch command' }),
	}),
	prepareArguments: (args: unknown) =>
		typeof args === 'string' ? { input: args } : (args as { input: string }),
	promptSnippet: 'Apply Codex-format file patches with apply_patch',
});

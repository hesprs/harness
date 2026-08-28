import type { Extension } from '@repo/shared/contract';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { errText, text } from '@repo/shared/text';
/**
 * Apply_patch: Codex-style patch envelopes (Add/Update/Delete/Move) applied
 * to the filesystem. Ported from code-yeongyu/pi-apply-patch (parser, chunk
 * seeking with fuzzy fallback, application); TUI preview omitted.
 */
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Type } from 'typebox';
import { activate } from './common.ts';

export type PatchResult = {
	summary: string;
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

function hasErrorCode(error: unknown, code: string): boolean {
	return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
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

function replaceChunks(content: string, filePath: string, chunks: Array<PatchChunk>): string {
	const originalLines = splitFileLines(content);
	const replacements: Array<{ start: number; oldLength: number; newLines: Array<string> }> = [];
	let lineIndex = 0;

	for (const chunk of chunks) {
		for (const changeContext of chunk.changeContexts) {
			const contextMatch = seekSequence(originalLines, [changeContext], lineIndex, false);
			if (contextMatch === undefined)
				throw new PatchApplicationError(
					`Failed to find context '${changeContext}' in ${filePath}`,
				);

			lineIndex = contextMatch.index + 1;
		}

		if (chunk.oldLines.length === 0) {
			const insertionIndex =
				originalLines.at(-1) === '' ? originalLines.length - 1 : originalLines.length;
			replacements.push({ newLines: chunk.newLines, oldLength: 0, start: insertionIndex });
			continue;
		}

		let pattern = chunk.oldLines;
		let newLines = chunk.newLines;
		let foundAt = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		if (foundAt === undefined && pattern.at(-1) === '') {
			pattern = pattern.slice(0, -1);
			if (newLines.at(-1) === '') newLines = newLines.slice(0, -1);

			foundAt = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
		}
		if (foundAt === undefined)
			throw new PatchApplicationError(
				`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join('\n')}`,
			);

		replacements.push({ newLines, oldLength: pattern.length, start: foundAt.index });
		lineIndex = foundAt.index + pattern.length;
	}

	const nextLines = [...originalLines];
	for (const replacement of replacements.sort((left, right) => right.start - left.start))
		nextLines.splice(replacement.start, replacement.oldLength, ...replacement.newLines);

	nextLines.push('');
	return nextLines.join('\n');
}

async function applySingleHunk(cwd: string, hunk: ParsedPatch): Promise<string> {
	const absolutePath = path.resolve(cwd, hunk.filePath);

	if (hunk.type === 'add') {
		await mkdir(path.dirname(absolutePath), { recursive: true });
		await Bun.write(absolutePath, hunk.content);
		return `add: ${hunk.filePath}`;
	}

	if (hunk.type === 'delete') {
		await stat(absolutePath);
		await rm(absolutePath);
		return `delete: ${hunk.filePath}`;
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

		return `move: ${hunk.filePath} -> ${hunk.movePath}`;
	}

	await Bun.write(absolutePath, nextContent);
	return `update: ${hunk.filePath}`;
}

/** Apply a patch body relative to `root`. Throws on malformed or failing patches. */
export async function applyPatch(root: string, patch: string): Promise<PatchResult> {
	const summaries: Array<string> = [];
	for (const hunk of parseNonEmptyPatch(patch))
		try {
			summaries.push(await applySingleHunk(root, hunk));
		} catch (error) {
			if (hasErrorCode(error, 'ENOENT'))
				throw new PatchApplicationError(
					`file not found while applying patch: ${String(error)}`,
				);

			throw error;
		}

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

// Extension that registers the freeform `apply_patch` tool.
export const toolApplyPatch: Extension = (pi) => {
	const tool = defineTool({
		description: FREEFORM_DESCRIPTION,
		// oxlint-disable-next-line eslint/max-params -- pi's execute callback is a fixed 5-param signature
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const result = await applyPatch(ctx.cwd, params.input);
				return text(result.summary);
			} catch (error) {
				return text(`apply_patch failed: ${errText(error)}`, true);
			}
		},
		label: 'ApplyPatch',
		name: 'apply_patch',
		parameters: Type.Object({
			input: Type.String({ description: 'The entire apply_patch command' }),
		}),
		prepareArguments: (args: unknown) =>
			typeof args === 'string' ? { input: args } : (args as { input: string }),
		promptSnippet: 'Apply Codex-format file patches with apply_patch',
	});
	pi.registerTool(
		Object.assign(tool, {
			freeform: { definition: LARK_GRAMMAR, syntax: 'lark', type: 'grammar' },
		}),
	);
	activate(pi, 'apply_patch');
};

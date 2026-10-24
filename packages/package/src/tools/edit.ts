import { defineTool } from '@earendil-works/pi-coding-agent';
import { errText, text } from '@repo/shared/text';
import { Type } from 'typebox';
/**
 * Fuzzy edit tool: replaces Pi's built-in exact-match editor (a same-named extension tool wins in
 * Pi's tool registry). Matching first tries the exact substring, then a whitespace-less pass: every
 * whitespace character is stripped from both sides. and a fuzzy match always replaces whole lines
 * of real file text — never the query. An ambiguous match is reported with 1-indexed line numbers
 * instead of guessing; per-edit `replaceAll` opts into every occurrence instead. All edits in one
 * call match the original content (not incrementally) and apply bottom-up. A bad edit never sinks
 * the others: it is skipped and named in `failures`, while the matchable ones still land and are
 * named in `applied`.
 */
import type { Extension } from '@repo/shared/contract';
import type { Static } from 'typebox';

/** One targeted replacement. */
export type EditInput = { newText: string; oldText: string; replaceAll?: boolean };

/**
 * Whitespace-less, escape-agnostic normalization: every whitespace character vanishes. `indices[i]`
 * is the source offset of chunk character `i`.
 */
function normalizeChunks(source: string): { chunks: string; indices: Array<number> } {
	const chars: Array<string> = [];
	const indices: Array<number> = [];
	for (let i = 0; i < source.length; i++) {
		const char = source[i] as string;
		if (/\s/u.test(char)) continue;
		chars.push(char);
		indices.push(i);
	}
	return { chunks: chars.join(''), indices };
}

/**
 * Every occurrence of `oldText` as real-text spans: the exact substring when present, else the
 * line-expanded whitespace/escape-agnostic match.
 */
function resolveSpans(
	content: string,
	oldText: string,
): { spans?: Array<{ end: number; start: number }>; failure?: string } {
	if (content.includes(oldText)) {
		const spans: Array<{ end: number; start: number }> = [];
		let at = content.indexOf(oldText);
		while (at !== -1) {
			spans.push({ end: at + oldText.length, start: at });
			at = content.indexOf(oldText, at + 1);
		}
		return { spans };
	}
	const { chunks, indices } = normalizeChunks(content);
	const query = normalizeChunks(oldText).chunks;
	if (!query) return { failure: 'oldText is empty once whitespace is removed' };
	const hits: Array<number> = [];
	let at = chunks.indexOf(query);
	while (at !== -1) {
		hits.push(at);
		at = chunks.indexOf(query, at + 1);
	}
	if (!hits.length)
		return { failure: 'oldText not found: no exact or whitespace/escape-agnostic match' };
	const lineEnd = (offset: number): number => {
		const newline = content.indexOf('\n', offset);
		return newline === -1 ? content.length : newline;
	};
	return {
		spans: hits.map((hit) => ({
			end: lineEnd(indices[hit + query.length - 1] as number),
			start: content.lastIndexOf('\n', indices[hit] as number) + 1,
		})),
	};
}

type Span = { edit: number; end: number; replacement: string; start: number };

/**
 * A renderable diff (`+line`/`-line`/context hunks, pi's renderDiff format) of the applied spans —
 * the changed regions are known exactly, so no general-purpose diff algorithm is needed.
 */
export function diffSpans(before: string, spans: Array<Span>, context = 4): string {
	const allLines = before.split('\n');
	const visible = before.endsWith('\n') ? allLines.slice(0, -1) : allLines;
	const width = String(allLines.length).length;
	const out: Array<string> = [];
	let delta = 0; // Added minus removed lines so far
	let cursor = 0; // First unchanged line not yet emitted
	// Unchanged lines `from`..`to`. An `edge` gap shows the lines nearest The change(s); a longer `inner` gap elides its middle with '...'.
	const emitGap = (from: number, to: number, edge: 'inner' | 'leading' | 'trailing'): void => {
		if (to <= from) return;
		let start = from;
		if (edge === 'leading' && to - from > context) {
			out.push(` ${' '.repeat(width)} ...`);
			start = to - context;
		} else if (edge === 'trailing' && to - from > context) {
			for (let l = from; l < from + context; l++)
				out.push(` ${String(l + 1).padStart(width, ' ')} ${visible[l] ?? ''}`);
			out.push(` ${' '.repeat(width)} ...`);
			return;
		} else if (edge === 'inner' && to - from > context * 2) {
			for (let l = from; l < from + context; l++)
				out.push(` ${String(l + 1).padStart(width, ' ')} ${visible[l] ?? ''}`);
			out.push(` ${' '.repeat(width)} ...`);
			start = to - context;
		}
		for (let l = start; l < to; l++)
			out.push(` ${String(l + 1).padStart(width, ' ')} ${visible[l] ?? ''}`);
	};
	const lineAt = (offset: number): number => before.slice(0, offset).split('\n').length - 1;
	const dropTrailingEmpty = (lines: Array<string>): Array<string> =>
		lines.at(-1) === '' ? lines.slice(0, -1) : lines;
	for (const span of spans) {
		const startLine = lineAt(span.start);
		const removed = dropTrailingEmpty(before.slice(span.start, span.end).split('\n'));
		const added = dropTrailingEmpty(span.replacement.split('\n'));
		emitGap(cursor, startLine, span === spans[0] ? 'leading' : 'inner');
		for (let k = 0; k < removed.length; k++)
			out.push(`-${String(startLine + k + 1).padStart(width, ' ')} ${removed[k] ?? ''}`);
		for (let k = 0; k < added.length; k++)
			out.push(
				`+${String(startLine + delta + k + 1).padStart(width, ' ')} ${added[k] ?? ''}`,
			);
		delta += added.length - removed.length;
		cursor = startLine + removed.length;
	}
	emitGap(cursor, visible.length, 'trailing');
	return out.join('\n');
}

/**
 * Apply every edit to `content` (LF-normalized): match all against the original, write bottom-up.
 * Unmatchable or clashing edits are skipped and reported; whatever still matches is applied.
 */
export function applyEdits(
	content: string,
	edits: Array<EditInput>,
): { applied: Array<number>; content: string; diff?: string; failures: Array<string> } {
	const spans: Array<Span> = [];
	const problems: Array<{ index: number; message: string }> = [];
	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i] as EditInput;
		const resolved = resolveSpans(content, edit.oldText);
		if (resolved.failure) {
			problems.push({ index: i, message: `edits[${i}]: ${resolved.failure}` });
			continue;
		}
		const found = resolved.spans ?? [];
		if (found.length > 1 && !(edit.replaceAll === true)) {
			problems.push({
				index: i,
				message: `edits[${i}]: oldText is ambiguous: matches at lines ${found
					.map((span) => content.slice(0, span.start).split('\n').length)
					.join(', ')} — add surrounding context or set replaceAll`,
			});
			continue;
		}
		if (found.some((span) => content.slice(span.start, span.end) === edit.newText)) {
			problems.push({
				index: i,
				message: `edits[${i}]: an edit replaces the matched text with itself — no change`,
			});
			continue;
		}
		for (const span of found)
			spans.push({ edit: i, end: span.end, replacement: edit.newText, start: span.start });
	}
	spans.sort((a, b) => a.start - b.start);
	const kept: Array<Span> = [];
	for (const span of spans) {
		const prev = kept.at(-1);
		if (prev && span.start < prev.end) {
			problems.push({
				index: span.edit,
				message: `edits[${span.edit}] overlaps edits[${prev.edit}] — merge them into one edit`,
			});
			continue;
		}
		kept.push(span);
	}
	let result = content;
	for (const span of kept.toReversed())
		result = result.slice(0, span.start) + span.replacement + result.slice(span.end);

	return {
		applied: [...new Set(kept.map((span) => span.edit))].sort((a, b) => a - b),
		content: result,
		...(kept.length ? { diff: diffSpans(content, kept) } : {}),
		failures: problems.toSorted((a, b) => a.index - b.index).map((problem) => problem.message),
	};
}

/**
 * Edit a file in place. The model never includes an invisible BOM in oldText, and CRLF line endings
 * round-trip: matching happens on LF-normalized content. Returns the applied edit indices, the
 * renderable diff, and the per-edit failures of whatever got skipped.
 */
export async function editFile(
	path: string,
	edits: Array<EditInput>,
): Promise<{ applied: Array<number>; diff?: string; failures: Array<string> }> {
	// Bun.file().text() strips a leading BOM — decode with it kept.
	const raw = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await Bun.file(path).bytes());
	const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
	const content = bom === '' ? raw : raw.slice(1);
	const crlf = content.includes('\r\n');
	const normalized = crlf ? content.replaceAll('\r\n', '\n') : content;
	const applied = applyEdits(normalized, edits);
	if (applied.applied.length) {
		const finalText = crlf ? applied.content.replaceAll('\n', '\r\n') : applied.content;
		await Bun.write(path, bom + finalText);
	}
	return { applied: applied.applied, diff: applied.diff, failures: applied.failures };
}

const editItemSchema = Type.Object({
	newText: Type.String({ description: 'Replacement text.' }),
	oldText: Type.String({
		description:
			'Text to find. Whitespace, indentation, line breaks, and literal escapes may drift, but the text must be unique in the file unless replaceAll is set.',
	}),
	replaceAll: Type.Optional(
		Type.Boolean({ description: 'Replace every occurrence instead of skipping as ambiguous.' }),
	),
});

const editOutputSchema = Type.Object({
	applied: Type.Array(Type.Number(), {
		description: '0-indexed edit indices that were written to disk',
	}),
	diff: Type.Optional(Type.String({ description: 'Renderable diff of applied changes' })),
	failures: Type.Array(Type.String(), {
		description: 'Per-edit failure messages for skipped edits',
	}),
});

type EditOutput = Static<typeof editOutputSchema>;

// Extension that registers the fuzzy `edit` tool, overriding Pi's built-in.
export const toolEdit: Extension = (pi) => {
	pi.registerTool(
		defineTool({
			description:
				'Edit a file by targeted text replacement. Each edit is matched against the original file, oldText should match file content. For ambiguous oldText (many matches), add surrounding context or set replaceAll. Use this and NEVER use Python or Bash to edit files.',
			async execute(_toolCallId, params) {
				try {
					const outcome = await editFile(params.path, params.edits);
					const structuredContent: EditOutput = {
						applied: outcome.applied,
						...(outcome.diff ? { diff: outcome.diff } : {}),
						failures: outcome.failures,
					};
					if (outcome.failures.length) {
						const head = outcome.applied.length
							? `applied ${outcome.applied.length}/${params.edits.length} edit(s) in ${params.path} (edits ${outcome.applied.join(', ')} are written to disk); skipped:`
							: `no edits applied in ${params.path}:`;
						return {
							content: [
								{
									text: `${head}\n${outcome.failures.map((f) => `- ${f}`).join('\n')}`,
									type: 'text' as const,
								},
							],
							details: { diff: outcome.diff },
							isError: true,
							structuredContent,
						};
					}
					return {
						content: [
							{
								text: `replaced ${params.edits.length} block(s) in ${params.path}`,
								type: 'text' as const,
							},
						],
						details: { diff: outcome.diff },
						structuredContent,
					};
				} catch (error) {
					return text(`could not edit ${params.path}: ${errText(error)}`, true);
				}
			},
			label: 'Edit',
			name: 'edit',
			outputSchema: editOutputSchema,
			parameters: Type.Object({
				edits: Type.Array(editItemSchema, {
					description:
						'One or more targeted replacements, matched against the original file, not incrementally. Unmatchable edits are skipped and reported while the rest apply.',
				}),
				path: Type.String({
					description: 'Path to the file to edit (relative or absolute).',
				}),
			}),
			renderShell: 'self',
		}),
	);
};

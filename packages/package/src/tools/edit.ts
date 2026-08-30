import type { Extension } from '@repo/shared/contract';
import { defineTool } from '@earendil-works/pi-coding-agent';
/**
 * Fuzzy edit tool: replaces Pi's built-in exact-match editor (a same-named
 * extension tool wins in Pi's tool registry). Matching first tries the
 * exact substring, then a whitespace-less, escape-agnostic pass: every
 * whitespace character — including its literal `\n`/`\t` spelling — is
 * stripped from both sides, literal `\\`/`\"`/`\'` count as their real
 * characters, and a fuzzy match always replaces whole lines of real file
 * text — never the query.
 *
 * An ambiguous match fails with 1-indexed line numbers instead of guessing;
 * the top-level `replaceAll` opts into every occurrence instead. All edits
 * in one call match the original content (not incrementally) and apply
 * bottom-up. Failures name the offending `edits[i]` index.
 */
import { errText, text } from '@repo/shared/text';
import { Type } from 'typebox';
import { registerActive } from './common.ts';

/** One targeted replacement. */
export type EditInput = {
	newText: string;
	oldText: string;
};

/** Whitespace-less, escape-agnostic normalization: every whitespace
 * character — including its literal `\n`/`\t` spelling — vanishes, while
 * literal `\\`/`\"`/`\'` become their real characters. `indices[i]` is the
 * source offset of chunk character `i`. */
function normalizeChunks(source: string): { chunks: string; indices: Array<number> } {
	const unescapes: Record<string, string> = { '"': '"', "'": "'", '\\': '\\', n: '\n', t: '\t' };
	const chars: Array<string> = [];
	const indices: Array<number> = [];
	for (let i = 0; i < source.length; i++) {
		const unescaped = source[i] === '\\' ? unescapes[source[i + 1] ?? ''] : undefined;
		if (unescaped !== undefined) i++;
		if (/\s/u.test(unescaped ?? source[i] ?? '')) continue;
		chars.push(unescaped ?? source[i] ?? '');
		indices.push(i);
	}
	return { chunks: chars.join(''), indices };
}

/** Every occurrence of `oldText` as real-text spans: the exact substring
 * when present, else the line-expanded whitespace/escape-agnostic match. */
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

/** A renderable diff (`+line`/`-line`/context hunks, pi's renderDiff format)
 * of the applied spans — the changed regions are known exactly, so no
 * general-purpose diff algorithm is needed. */
export function diffSpans(before: string, spans: Array<Span>, context = 4): string {
	const allLines = before.split('\n');
	const visible = before.endsWith('\n') ? allLines.slice(0, -1) : allLines;
	const width = String(allLines.length).length;
	const out: Array<string> = [];
	let delta = 0; // Added minus removed lines so far
	let cursor = 0; // First unchanged line not yet emitted
	// Unchanged lines `from`..`to`. An `edge` gap shows the lines nearest
	// The change(s); a longer `inner` gap elides its middle with '...'.
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

/** Apply every edit to `content` (LF-normalized): match all against the
 * original, refuse overlaps, write bottom-up. Nothing changes on failure. */
export function applyEdits(
	content: string,
	edits: Array<EditInput>,
	replaceAll = false,
): {
	content: string;
	diff?: string;
	failure?: string;
} {
	const spans: Array<Span> = [];
	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i] as EditInput;
		const resolved = resolveSpans(content, edit.oldText);
		if (resolved.failure) return { content, failure: `edits[${i}]: ${resolved.failure}` };
		const found = resolved.spans ?? [];
		if (found.length > 1 && !replaceAll)
			return {
				content,
				failure: `edits[${i}]: oldText is ambiguous: matches at lines ${found
					.map((span) => content.slice(0, span.start).split('\n').length)
					.join(', ')} — add surrounding context or set replaceAll`,
			};
		for (const span of found) {
			if (content.slice(span.start, span.end) === edit.newText)
				return {
					content,
					failure: `edits[${i}]: an edit replaces the matched text with itself — no change`,
				};
			spans.push({ edit: i, end: span.end, replacement: edit.newText, start: span.start });
		}
	}
	spans.sort((a, b) => a.start - b.start);
	for (let i = 1; i < spans.length; i++) {
		const prev = spans[i - 1];
		const curr = spans[i];
		if (prev && curr && curr.start < prev.end)
			return {
				content,
				failure: `edits[${prev.edit}] and edits[${curr.edit}] overlap — merge them into one edit`,
			};
	}
	let result = content;
	for (const span of spans.toReversed())
		result = result.slice(0, span.start) + span.replacement + result.slice(span.end);

	return { content: result, diff: diffSpans(content, spans) };
}

/** Edit a file in place. The model never includes an invisible BOM in
 * oldText, and CRLF line endings round-trip: matching happens on
 * LF-normalized content. Returns the failure message, if any, and the
 * renderable diff on success. */
export async function editFile(
	path: string,
	edits: Array<EditInput>,
	replaceAll = false,
): Promise<{ diff?: string; failure?: string }> {
	// Bun.file().text() strips a leading BOM — decode with it kept.
	const raw = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await Bun.file(path).bytes());
	const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
	const content = bom === '' ? raw : raw.slice(1);
	const crlf = content.includes('\r\n');
	const normalized = crlf ? content.replaceAll('\r\n', '\n') : content;
	const applied = applyEdits(normalized, edits, replaceAll);
	if (applied.failure) return { failure: applied.failure };
	const finalText = crlf ? applied.content.replaceAll('\n', '\r\n') : applied.content;
	await Bun.write(path, bom + finalText);
	return { diff: applied.diff };
}

const editItemSchema = Type.Object({
	newText: Type.String({ description: 'Replacement text.' }),
	oldText: Type.String({
		description:
			'Text to find. Whitespace, indentation, line breaks, and literal escapes may drift, but the text must be unique in the file unless replaceAll is set.',
	}),
});

// Extension that registers the fuzzy `edit` tool, overriding Pi's built-in.
export const toolEdit: Extension = (pi) => {
	registerActive(
		pi,
		defineTool({
			description:
				'Edit a file by targeted text replacement. Each edit is matched against the original file, oldText should match file content. For ambiguous oldText (many matches), add surrounding context or set replaceAll. Use this and NEVER use Python or Bash to edit files.',
			async execute(_toolCallId, params) {
				try {
					const outcome = await editFile(
						params.path,
						params.edits,
						params.replaceAll === true,
					);
					if (outcome.failure) return text(`${outcome.failure} (${params.path})`, true);
					return {
						content: [
							{
								text: `replaced ${params.edits.length} block(s) in ${params.path}`,
								type: 'text' as const,
							},
						],
						details: { diff: outcome.diff },
					};
				} catch (error) {
					return text(`could not edit ${params.path}: ${errText(error)}`, true);
				}
			},
			label: 'Edit',
			name: 'edit',
			parameters: Type.Object({
				edits: Type.Array(editItemSchema, {
					description:
						'One or more targeted replacements, matched against the original file, not incrementally. Do not include overlapping edits.',
				}),
				path: Type.String({
					description: 'Path to the file to edit (relative or absolute).',
				}),
				replaceAll: Type.Optional(
					Type.Boolean({
						description: 'Replace every occurrence instead of failing on ambiguity.',
					}),
				),
			}),
		}),
	);
};

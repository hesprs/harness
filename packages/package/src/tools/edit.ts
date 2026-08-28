import type { Extension } from '@repo/shared/contract';
import { defineTool, renderDiff } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
/**
 * Fuzzy edit tool: replaces Pi's built-in exact-match editor (a same-named
 * extension tool wins in Pi's tool registry). Matching runs three passes,
 * in order: exact, whitespace/indentation-flexible, and escape-normalized.
 * Every pass returns text that exists in the file, so a replacement always
 * targets real content — never the query.
 *
 * An ambiguous match fails with 1-indexed line numbers instead of guessing;
 * `replaceAll` opts into every occurrence instead. All edits in one call
 * match the original content (not incrementally) and apply bottom-up.
 */
import { errText, text } from '@repo/shared/text';
import { Type } from 'typebox';
import { registerActive } from './common.ts';

/** One targeted replacement. */
export type EditInput = {
	newText: string;
	oldText: string;
	replaceAll?: boolean;
};

/** Line fingerprint for the flexible pass: order-preserving whitespace
 * collapse — indentation, inner runs, and trailing whitespace all vanish. */
const fingerprint = (line: string): string => line.trim().replaceAll(/\s+/gu, ' ');

/** 1-indexed line numbers of every occurrence of `needle` in `content`. */
function occurrenceLines(content: string, needle: string): Array<number> {
	const lines: Array<number> = [];
	let at = content.indexOf(needle);
	while (at !== -1) {
		lines.push(content.slice(0, at).split('\n').length);
		at = content.indexOf(needle, at + 1);
	}
	return lines;
}

/** Pass 2: match non-blank lines by fingerprint, skipping blank lines on
 * either side — tolerates indentation drift, whitespace runs, and
 * blank-line differences. Returns the real file text of the match. */
function findFlexible(content: string, oldText: string): string | undefined {
	const oldLines = oldText
		.split('\n')
		.filter((line) => line.trim() !== '')
		.map(fingerprint);
	const firstOld = oldLines[0];
	if (firstOld === undefined) return undefined;
	const lines = content.split('\n');
	for (let i = 0; i < lines.length; i++) {
		if (fingerprint(lines[i] ?? '') !== firstOld) continue;
		let matched = 1;
		let last = i;
		for (let j = i + 1; j < lines.length && matched < oldLines.length; j++) {
			const line = lines[j] ?? '';
			if (line.trim() === '') continue; // Blank lines come and go
			if (fingerprint(line) !== oldLines[matched]) break;
			last = j;
			matched++;
		}
		if (matched === oldLines.length) {
			const actual = lines.slice(i, last + 1).join('\n');
			if (content.includes(actual)) return actual;
		}
	}
	return undefined;
}

/** Pass 3: the model wrote literal `\n`/`\t`/`\\`/`\"`/`\'` where the file
 * has the real characters. */
function findEscaped(content: string, oldText: string): string | undefined {
	const unescaped = oldText
		.replaceAll(String.raw`\n`, '\n')
		.replaceAll(String.raw`\t`, '\t')
		.replaceAll(String.raw`\\`, '\\')
		.replaceAll(String.raw`\"`, '"')
		.replaceAll(String.raw`\'`, "'");
	if (unescaped === oldText) return undefined;
	return content.includes(unescaped) ? unescaped : undefined;
}

/** Resolve one edit's real target text, or a failure message for a retry. */
function resolveActual(content: string, edit: EditInput): { actual: string } | { failure: string } {
	const actual = content.includes(edit.oldText)
		? edit.oldText
		: (findFlexible(content, edit.oldText) ?? findEscaped(content, edit.oldText));
	if (actual === undefined)
		return { failure: 'oldText not found: no exact, whitespace-flexible, or escaped match' };

	const lines = occurrenceLines(content, actual);
	if (lines.length > 1 && edit.replaceAll !== true)
		return {
			failure: `oldText is ambiguous: matches at line(s) ${lines.join(', ')} — add surrounding context or set replaceAll`,
		};

	return { actual };
}

type Span = { end: number; replacement: string; start: number };

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
): {
	content: string;
	diff?: string;
	failure?: string;
} {
	const spans: Array<Span> = [];
	for (const edit of edits) {
		const resolved = resolveActual(content, edit);
		if ('failure' in resolved) return { content, failure: resolved.failure };
		if (resolved.actual === edit.newText)
			return {
				content,
				failure: 'an edit replaces the matched text with itself — no change',
			};

		const starts: Array<number> = [];
		let at = content.indexOf(resolved.actual);
		while (at !== -1) {
			starts.push(at);
			if (edit.replaceAll !== true) break;
			at = content.indexOf(resolved.actual, at + 1);
		}
		for (const start of starts)
			spans.push({ end: start + resolved.actual.length, replacement: edit.newText, start });
	}
	spans.sort((a, b) => a.start - b.start);
	for (let i = 1; i < spans.length; i++) {
		const prev = spans[i - 1];
		const curr = spans[i];
		if (prev !== undefined && curr !== undefined && curr.start < prev.end)
			return { content, failure: 'edits overlap — merge them into one edit' };
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
): Promise<{ diff?: string; failure?: string }> {
	// Bun.file().text() strips a leading BOM — decode with it kept.
	const raw = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await Bun.file(path).bytes());
	const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
	const content = bom === '' ? raw : raw.slice(1);
	const crlf = content.includes('\r\n');
	const normalized = crlf ? content.replaceAll('\r\n', '\n') : content;
	const applied = applyEdits(normalized, edits);
	if (applied.failure !== undefined) return { failure: applied.failure };
	const finalText = crlf ? applied.content.replaceAll('\n', '\r\n') : applied.content;
	await Bun.write(path, bom + finalText);
	return { diff: applied.diff };
}

const editItemSchema = Type.Object({
	newText: Type.String({ description: 'Replacement text.' }),
	oldText: Type.String({
		description:
			'Text to find. Whitespace and indentation may drift, but the text must be unique in the file unless replaceAll is set.',
	}),
	replaceAll: Type.Optional(
		Type.Boolean({
			description: 'Replace every occurrence instead of failing on ambiguity.',
		}),
	),
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
					const outcome = await editFile(params.path, params.edits);
					if (outcome.failure !== undefined)
						return text(`${outcome.failure} (${params.path})`, true);
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
			}),
			renderResult(result, _options, theme, context) {
				if (context.isError) {
					const message = result.content
						.filter((part) => part.type === 'text')
						.map((part) => part.text)
						.join('\n');
					return new Text(theme.fg('error', message), 0, 0);
				}
				const diff = result.details?.diff;
				return new Text(
					typeof diff === 'string' && diff !== '' ? renderDiff(diff) : '',
					0,
					0,
				);
			},
		}),
	);
};

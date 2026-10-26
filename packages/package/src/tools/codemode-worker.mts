// oxlint-disable unicorn/require-post-message-target-origin
/**
 * Runs inside a Bun worker as a module: Bun transpiles the TypeScript, resolves imports from the
 * working directory, and keeps `import.meta`, which neither a data URL nor a vm script would do.
 * Tool calls and output cross to the host as messages; the script body is wrapped in a function so
 * top-level `return` works as it did in the QuickJS sandbox.
 */

/** Mirrors the limits of the QuickJS prelude, so unsandboxed scripts stay within the same budget. */
const MAX_STORE_VALUE_CHARS = 256 * 1024;
const MAX_STORE_TOTAL_CHARS = 1024 * 1024;
const MAX_OUTPUT_CHARS = 16 * 1024 * 1024;
const MAX_OUTPUT_ITEMS = 100_000;

type Output =
	| { type: 'text'; text: string; console?: true }
	| { type: 'image'; data: string; mimeType: string };

type ScriptError = { kind?: 'script'; name?: string; message: string; stack?: string };

type StoreWrites = { set: Record<string, unknown>; delete: Array<string> };

type StartMessage = {
	type: 'start';
	code: string;
	tools: Array<{ name: string; description: string }>;
	globals: Array<{ name: string; spread: boolean }>;
	store: Record<string, unknown>;
};

type CallResult =
	| { type: 'callResult'; id: number; ok: true; value: unknown }
	| { type: 'callResult'; id: number; ok: false; error: string };

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** Thrown to unwind the script after `finish()`; never reported. */
const EXIT = new Error('codemode exit');

const pending = new Map<number, Pending>();
let nextId = 0;
let finished = false;
let moduleUrl = '';
let outputChars = 0;
let outputItems = 0;

/** A static import, at the start of the script or after a statement ends. Its clause may span lines. */
const IMPORT =
	/(?:^|(?<=[;}\n]))[ \t]*import\s+(?:(?<clause>[\s\S]*?)\s+from\s*)?(?<quote>['"])(?<specifier>[^'"]+)\k<quote>\s*;?/gmu;
/** The `* as ns` form of an import clause. */
const NAMESPACE_CLAUSE = /^\*\s+as\s+(?<local>\w+)$/u;
/** The `{ a, b as c }` part of an import clause. */
const NAMED_CLAUSE = /\{(?<bindings>[\s\S]*)\}/u;
/** A single `a as b` binding. */
const RENAME = /^(?<imported>\S+)\s+as\s+(?<local>\S+)$/u;

/** Rewrite a static import into an awaited dynamic one, so imports work at any position. */
function rewriteImport(clause: string | undefined, specifier: string): string {
	const source = JSON.stringify(specifier);
	if (!clause) return `await import(${source});`;
	// Type-only imports vanish at compile time; there is nothing to import at runtime.
	if (/^type\s/u.test(clause)) return '';
	const namespace = NAMESPACE_CLAUSE.exec(clause.trim());
	if (namespace?.groups) return `const ${namespace.groups.local} = await import(${source});`;
	const named = NAMED_CLAUSE.exec(clause);
	const fallback = (named ? clause.slice(0, named.index) : clause).replace(/,\s*$/u, '').trim();
	const fields = fallback ? [`default: ${fallback}`] : [];
	for (const binding of named?.groups?.bindings?.split(',') ?? []) {
		const trimmed = binding.trim();
		if (trimmed) fields.push(trimmed.replace(RENAME, '$<imported>: $<local>'));
	}
	return `const { ${fields.join(', ')} } = await import(${source});`;
}

function compile(code: string): string {
	const body = code.replace(IMPORT, (_, clause: string | undefined, _quote, specifier: string) =>
		rewriteImport(clause, specifier),
	);
	return `${WRAPPER_OPEN}${body}\n})();`;
}

let stored = new Map<string, unknown>();
let writes = new Map<string, unknown>();
let storedChars = 0;

function serializeWrites(): StoreWrites {
	const entries = [...writes];
	const deleted = entries.filter(([, value]) => value === undefined).map(([key]) => key);
	return {
		delete: deleted,
		set: Object.fromEntries(entries.filter(([, value]) => value !== undefined)),
	};
}

/** Drop the blob URL the script was compiled from, so errors read like a normal script file. */
function clean(message: string | undefined): string | undefined {
	return message?.split(moduleUrl).join('codemode.ts');
}

/** One Bun parse failure, as found on `AggregateError.errors` for the script module. */
type BuildMessage = {
	message: string;
	position?: { column: number; line: number; lineText: string };
};

/** First line of the compiled module, prepended to the script's first line by `compile`. */
const WRAPPER_OPEN = 'export default await (async () => {';

/**
 * Bun reports script parse failures as an aggregate of build messages; surface each with its exact
 * source position. Line numbers map to the script directly (the wrapper shares line 1), so only
 * first-line columns are shifted by the wrapper prefix.
 */
function describeSyntaxErrors(error: AggregateError): ScriptError | undefined {
	const details = (error.errors ?? [])
		.map((sub) => {
			const { position, message } = sub as BuildMessage;
			if (typeof position?.line !== 'number') return '';
			const column =
				position.line === 1 && position.column > WRAPPER_OPEN.length
					? position.column - WRAPPER_OPEN.length
					: position.column;
			const lineText =
				position.line === 1
					? position.lineText.slice(WRAPPER_OPEN.length).trim()
					: position.lineText.trim();
			return `line ${position.line}, column ${column}: ${message} (${lineText})`;
		})
		.filter((detail) => detail !== '');
	if (details.length === 0) return undefined;
	return {
		kind: 'script',
		message: `code contains ${details.length} syntax error${details.length === 1 ? '' : 's'}:\n${details.join('\n')}`,
		name: 'SyntaxError',
	};
}

function describeError(error: unknown): ScriptError {
	if (error instanceof AggregateError) {
		const syntax = describeSyntaxErrors(error);
		if (syntax) return syntax;
	}
	if (error instanceof Error)
		return { message: clean(error.message) ?? '', name: error.name, stack: clean(error.stack) };
	return { message: clean(String(error)) ?? '' };
}

function finish(ok: boolean, payload?: unknown): void {
	if (finished) return;
	finished = true;
	self.postMessage(
		ok
			? { ok: true, storeWrites: serializeWrites(), type: 'done', value: payload }
			: { error: payload, ok: false, type: 'done' },
	);
}

function fail(error: unknown): never {
	finish(false, describeError(error));
	throw EXIT;
}

function emit(item: Output): void {
	if (finished) return;
	outputChars += item.type === 'image' ? item.data.length : item.text.length;
	outputItems++;
	if (outputChars > MAX_OUTPUT_CHARS || outputItems > MAX_OUTPUT_ITEMS)
		fail(
			new RangeError(
				`script output exceeded the limit of ${MAX_OUTPUT_CHARS} characters or ${MAX_OUTPUT_ITEMS} text(), image(), and console calls. Print a summary instead, or write large data to a file.`,
			),
		);
	self.postMessage({ item, type: 'output' });
}

function caller(
	target: 'tool' | 'global',
	name: string,
	spread: boolean,
): (...args: Array<unknown>) => Promise<unknown> {
	return (...args) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { reject, resolve });
			self.postMessage({ args: spread ? args : args[0], id, name, target, type: 'call' });
		});
}

/** Same normalization as pi-codemode's toCodemodeIdentifier, inlined: the worker cannot import it. */
function identifier(name: string): string {
	let result = '';
	for (const char of name) {
		const valid = result === '' ? /^[A-Za-z_$]$/u.test(char) : /^[A-Za-z0-9_$]$/u.test(char);
		result += valid ? char : '_';
	}
	return result === '' ? '_' : result;
}

function store(key: string, value: unknown): void {
	if (typeof key !== 'string') throw new TypeError('store() key must be a string');
	const previous = stored.has(key)
		? key.length + (JSON.stringify(stored.get(key))?.length ?? 0)
		: 0;
	if (value === undefined) {
		stored.delete(key);
		storedChars -= previous;
		writes.set(key, undefined);
		return;
	}
	let json: string | undefined;
	try {
		json = JSON.stringify(value);
	} catch (error) {
		throw new TypeError(`store(${JSON.stringify(key)}) value is not JSON-serializable`, {
			cause: error,
		});
	}
	if (json === undefined)
		throw new TypeError(`store(${JSON.stringify(key)}) value is not JSON-serializable`);
	if (json.length > MAX_STORE_VALUE_CHARS)
		throw new RangeError(
			`store(${JSON.stringify(key)}) value has more than ${MAX_STORE_VALUE_CHARS} characters of JSON`,
		);
	const next = storedChars - previous + key.length + json.length;
	if (next > MAX_STORE_TOTAL_CHARS)
		throw new RangeError(
			`store is full: stored values would exceed ${MAX_STORE_TOTAL_CHARS} characters of JSON`,
		);
	const parsed: unknown = JSON.parse(json);
	stored.set(key, parsed);
	storedChars = next;
	writes.set(key, parsed);
}

function load(key: string): unknown {
	if (typeof key !== 'string') throw new TypeError('load() key must be a string');
	return stored.get(key);
}

function outputText(value: unknown): string {
	const json = typeof value === 'object' && value !== null ? JSON.stringify(value) : undefined;
	return json ?? String(value);
}

function text(value: unknown): void {
	emit({ text: outputText(value), type: 'text' });
}

const IMAGE_EXPECTS =
	'image expects a base64 data URI string, an object with image_url, or a raw MCP image block';
/** Base64 prefixes of the signatures providers accept inline, matching the QuickJS prelude. */
const IMAGE_SIGNATURES = [
	['image/png', 'iVBORw0KGg'],
	['image/jpeg', '/9j/'],
	['image/gif', 'R0lGOD'],
	['image/webp', 'UklGR'],
] as const;
const DATA_URI = /^data:(?<mime>[^;,]+);base64,(?<data>[A-Za-z0-9+/]+={0,2})$/u;

function image(value: unknown): void {
	let url: string | undefined;
	if (typeof value === 'string') url = value;
	else if (value && typeof value === 'object') {
		const candidate = value as { image_url?: unknown; type?: unknown; data?: unknown };
		if (typeof candidate.image_url === 'string') url = candidate.image_url;
		else if (candidate.type === 'image' && typeof candidate.data === 'string')
			url = `data:;base64,${candidate.data}`;
	}
	if (typeof url !== 'string' || url === '') throw new TypeError(IMAGE_EXPECTS);
	const match = DATA_URI.exec(url.replaceAll(/\s+/gu, ''));
	if (!match?.groups) throw new TypeError(`invalid image output. ${IMAGE_EXPECTS}`);
	const data = match.groups.data ?? '';
	// Pi writes each image to a temp file, so only the formats it has an extension for are accepted.
	const mimeType = IMAGE_SIGNATURES.find((entry) => data.startsWith(entry[1]))?.[0];
	if (!mimeType)
		throw new TypeError(
			'invalid image output. The image data is not a PNG, JPEG, GIF, or WebP image',
		);
	emit({ data, mimeType, type: 'image' });
}

function exit(): never {
	finish(true);
	throw EXIT;
}

const consoleShim: Record<string, (...args: Array<unknown>) => void> = {};
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const)
	consoleShim[level] = (...args: Array<unknown>): void =>
		emit({ console: true, text: args.map(outputText).join(' '), type: 'text' });

async function run({
	code,
	tools: toolList,
	globals: globalList,
	store: initialStore,
}: StartMessage): Promise<void> {
	stored = new Map(Object.entries(initialStore));
	writes = new Map();
	for (const [key, value] of stored)
		storedChars += key.length + (JSON.stringify(value)?.length ?? 0);

	const tools = Object.create(null) as Record<string, unknown>;
	const allTools: Array<{ name: string; description: string }> = [];
	for (const { name, description } of toolList) {
		const jsName = identifier(name);
		const call = caller('tool', name, false);
		if (!(jsName in tools)) {
			tools[jsName] = call;
			allTools.push({ description, name: jsName });
		}
		if (!(name in tools)) tools[name] = call;
	}
	Object.freeze(tools);
	Object.freeze(allTools);

	const namespaces = new Map<string, Record<string, unknown>>();
	for (const { name, spread } of globalList) {
		const call = caller('global', name, spread);
		const dot = name.indexOf('.');
		if (dot === -1) {
			(globalThis as Record<string, unknown>)[name] = call;
			continue;
		}
		const namespace = name.slice(0, dot);
		let members = namespaces.get(namespace);
		if (!members) {
			members = {};
			namespaces.set(namespace, members);
		}
		members[name.slice(dot + 1)] = call;
	}
	for (const [namespace, members] of namespaces)
		(globalThis as Record<string, unknown>)[namespace] = Object.freeze(members);

	Object.assign(globalThis, {
		ALL_TOOLS: allTools,
		console: consoleShim,
		exit,
		image,
		load,
		store,
		text,
		tools,
	});

	moduleUrl = URL.createObjectURL(new Blob([compile(code)], { type: 'text/javascript' }));
	try {
		const module = (await import(moduleUrl)) as { default: unknown };
		// The host transfers the value with structured clone, so it is reduced to JSON as the QuickJS prelude did: undefined stays empty, anything else must be JSON-serializable.
		const json = JSON.stringify(module.default);
		finish(true, json === undefined ? undefined : JSON.parse(json));
	} catch (error) {
		if (error !== EXIT) finish(false, describeError(error));
	} finally {
		URL.revokeObjectURL(moduleUrl);
	}
}

let started = false;
self.addEventListener('message', (event: MessageEvent<StartMessage | CallResult>): void => {
	const message = event.data;
	if (message.type === 'callResult') {
		const entry = pending.get(message.id);
		if (!entry) return;
		pending.delete(message.id);
		if (message.ok) entry.resolve(message.value);
		else entry.reject(new Error(message.error));
		return;
	}
	if (message.type !== 'start' || started) return;
	started = true;
	void run(message);
});

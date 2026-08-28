#!/usr/bin/env bun

const USAGE = `Usage: bun path/to/skill/fetch-docs.ts [--type <txt|json>] <libraryId> <query...>`;

function fail(message: string): never {
	console.error(message);
	console.error(USAGE);
	process.exit(1);
}

const rawArgs = Bun.argv.slice(2);

if (!rawArgs.length || rawArgs.includes('--help') || rawArgs.includes('-h')) {
	console.log(USAGE);
	process.exit(0);
}

let type = 'txt';
const positional: Array<string> = [];

for (let i = 0; i < rawArgs.length; i += 1) {
	const arg = rawArgs[i]!;

	if (arg === '--type' || arg === '-t') {
		const next = rawArgs[i + 1];
		if (!next) fail('Missing value for --type.');
		type = next;
		i += 1;
		continue;
	}

	if (arg.startsWith('--type=')) {
		type = arg.slice('--type='.length);
		continue;
	}

	positional.push(arg);
}

if (positional.length < 2) fail('Missing libraryId or query.');

const [libraryId, ...queryParts] = positional;
const query = queryParts.join(' ').trim();

if (!libraryId || !query) fail('Missing libraryId or query.');
if (type !== 'txt' && type !== 'json') fail(`Invalid type: ${type}`);

const url = new URL('https://context7.com/api/v2/context');
url.searchParams.set('libraryId', libraryId);
url.searchParams.set('query', query);
url.searchParams.set('type', type);

const response = await fetch(url);

if (!response.ok) {
	const body = await response.text();
	fail(`Request failed: ${response.status} ${response.statusText}\n${body}`);
}

if (type === 'txt') {
	const text = await response.text();
	process.stdout.write(text);
	if (!text.endsWith('\n')) process.stdout.write('\n');
	process.exit(0);
}

const data = await response.json();
console.log(JSON.stringify(data, undefined, 2));

#!/usr/bin/env bun

const USAGE = `Usage: bun path/to/skill/search-library.ts [--type <txt|json>] <libraryName> <query...>`;

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

let type = 'json';
const args: Array<string> = [];

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

	args.push(arg);
}

if (args.length < 2) fail('Missing libraryName or query.');

const [libraryName, ...queryParts] = args;
const query = queryParts.join(' ').trim();

if (!libraryName || !query) fail('Missing libraryName or query.');

const url = new URL('https://context7.com/api/v2/libs/search');
url.searchParams.set('libraryName', libraryName);
url.searchParams.set('query', query);

const response = await fetch(url);

if (!response.ok) {
	const body = await response.text();
	fail(`Request failed: ${response.status} ${response.statusText}\n${body}`);
}

if (type !== 'txt' && type !== 'json') fail(`Invalid type: ${type}`);

const data = (await response.json()) as { results?: Array<Record<string, unknown>> };
const result = data.results?.[0];

if (type === 'json') {
	console.log(JSON.stringify(result, undefined, 2));
	process.exit(0);
}

if (!result) {
	console.log('No result.');
	process.exit(0);
}

const item = result as {
	id?: string;
	title?: string;
	description?: string;
	totalSnippets?: string;
};
console.log(
	[
		`id: ${item.id ?? ''}`,
		`title: ${item.title ?? ''}`,
		`description: ${item.description ?? ''}`,
		`totalSnippets: ${item.totalSnippets ?? ''}`,
	].join('\n'),
);

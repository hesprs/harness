#!/usr/bin/env bun

import { mkdirSync, renameSync, statSync, existsSync } from 'fs';
import path from 'path';

export const VERSION = '1.0.0';
export const STATE_DIR = 'blueprint';
export const STATE_FILE = 'codemap.json';
export const LEGACY_STATE_FILE = 'cartography.json';
export const CODEMAP_FILE = 'codemap.md';

export type CodemapState = {
	metadata: {
		version: string;
		last_run: string;
		root: string;
		include_patterns: Array<string>;
		exclude_patterns: Array<string>;
		exceptions: Array<string>;
	};
	file_hashes: Record<string, string>;
	folder_hashes: Record<string, string>;
};

export type CommandOptions = {
	root?: string;
	include: Array<string>;
	exclude: Array<string>;
	exception: Array<string>;
};

export class PatternMatcher {
	regex?: RegExp;

	constructor(patterns: Array<string>) {
		if (!patterns.length) {
			this.regex = undefined;
			return;
		}

		const regexParts = patterns.map((pattern) => {
			let reg = pattern.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
			reg = reg.replace(/\\\*\\\*\//g, '(?:.*/)?');
			reg = reg.replace(/\\\*\\\*/g, '.*');
			reg = reg.replace(/\\\*/g, '[^/]*');
			reg = reg.replace(/\\\?/g, '.');
			if (pattern.endsWith('/')) reg += '.*';
			reg = pattern.startsWith('/') ? `^${reg.slice(1)}` : `(?:^|.*/)${reg}`;
			return `(?:${reg}$)`;
		});

		this.regex = new RegExp(regexParts.join('|'));
	}

	matches(filePath: string): boolean {
		if (!this.regex) return false;
		return this.regex.test(filePath);
	}
}

export async function loadGitignore(root: string): Promise<Array<string>> {
	const gitignorePath = path.join(root, '.gitignore');
	const file = Bun.file(gitignorePath);
	if (!(await file.exists())) return [];

	const text = await file.text();
	return text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith('#'));
}

export async function selectFiles(
	root: string,
	includePatterns: Array<string>,
	excludePatterns: Array<string>,
	exceptions: Array<string>,
	gitignorePatterns: Array<string>,
): Promise<Array<string>> {
	const includeMatcher = new PatternMatcher(includePatterns);
	const excludeMatcher = new PatternMatcher(excludePatterns);
	const gitignoreMatcher = new PatternMatcher(gitignorePatterns);
	const exceptionSet = new Set(exceptions);

	const glob = new Bun.Glob('**/*');
	const selected: Array<string> = [];

	for await (const relPath of glob.scan({ cwd: root, dot: false })) {
		const fullPath = path.join(root, relPath);

		// Bun.Glob matches both files and directories; filter to files only
		if (!statSync(fullPath).isFile()) continue;

		if (gitignoreMatcher.matches(relPath)) continue;
		if (excludeMatcher.matches(relPath) && !exceptionSet.has(relPath)) continue;

		if (includeMatcher.matches(relPath) || exceptionSet.has(relPath)) selected.push(relPath);
	}

	return selected.sort();
}

export async function computeFileHash(root: string, relPath: string): Promise<string> {
	try {
		const fullPath = path.join(root, relPath);
		const buffer = await Bun.file(fullPath).arrayBuffer();
		return new Bun.CryptoHasher('md5').update(buffer).digest('hex');
	} catch {
		return '';
	}
}

export async function computeFolderHash(
	folder: string,
	fileHashes: Record<string, string>,
): Promise<string> {
	const folderFiles = Object.entries(fileHashes)
		.filter(
			([filePath]) =>
				filePath.startsWith(`${folder}/`) || (folder === '.' && !filePath.includes('/')),
		)
		.sort(([a], [b]) => a.localeCompare(b));

	if (!folderFiles.length) return '';

	const hasher = new Bun.CryptoHasher('md5');
	for (const [filePath, hash] of folderFiles) hasher.update(`${filePath}:${hash}\n`);

	return hasher.digest('hex');
}

export function getFoldersWithFiles(files: Array<string>): Set<string> {
	const folders = new Set<string>(['.']);

	for (const relPath of files) {
		const parts = relPath.split('/').slice(0, -1);
		for (let i = 0; i < parts.length; i++) folders.add(parts.slice(0, i + 1).join('/'));
	}

	return folders;
}

export async function migrateLegacyState(root: string): Promise<boolean> {
	const stateDir = path.join(root, STATE_DIR);
	const legacyPath = path.join(stateDir, LEGACY_STATE_FILE);
	const statePath = path.join(stateDir, STATE_FILE);

	if ((await Bun.file(statePath).exists()) || !(await Bun.file(legacyPath).exists()))
		return false;

	mkdirSync(stateDir, { recursive: true });
	renameSync(legacyPath, statePath);
	console.log(`Migrated ${STATE_DIR}/${LEGACY_STATE_FILE} -> ${STATE_DIR}/${STATE_FILE}`);
	return true;
}

export async function loadState(root: string): Promise<CodemapState | undefined> {
	await migrateLegacyState(root);
	const statePath = path.join(root, STATE_DIR, STATE_FILE);
	const file = Bun.file(statePath);
	if (!(await file.exists())) return;

	try {
		return JSON.parse(await file.text()) as CodemapState;
	} catch {
		return;
	}
}

export async function saveState(root: string, state: CodemapState): Promise<void> {
	const stateDir = path.join(root, STATE_DIR);
	mkdirSync(stateDir, { recursive: true });
	const statePath = path.join(stateDir, STATE_FILE);
	await Bun.write(statePath, `${JSON.stringify(state, undefined, 2)}\n`);
}

export async function createEmptyCodemap(folderPath: string, folderName: string): Promise<void> {
	const codemapPath = path.join(folderPath, CODEMAP_FILE);
	const file = Bun.file(codemapPath);
	if (await file.exists()) return;

	const content = `# ${folderName}/

<!-- Fixer: Fill in this section with architectural understanding -->

## Responsibility

<!-- What is this folder's job in the system? -->

## Design

<!-- Key patterns, abstractions, architectural decisions -->

## Flow

<!-- How does data/control flow through this module? -->

## Integration

<!-- How does it connect to other parts of the system? Dependencies / dependents? -->
`;

	await Bun.write(codemapPath, content);
}

async function buildState(
	root: string,
	includePatterns: Array<string>,
	excludePatterns: Array<string>,
	exceptions: Array<string>,
	selectedFiles: Array<string>,
): Promise<{ state: CodemapState; folders: Set<string> }> {
	const fileHashes: Record<string, string> = {};

	// Compute hashes concurrently for massive speedup in Bun
	const hashPromises = selectedFiles.map(async (relPath) => {
		const hash = await computeFileHash(root, relPath);
		return [relPath, hash] as const;
	});

	const results = await Promise.all(hashPromises);
	for (const [relPath, hash] of results) fileHashes[relPath] = hash;

	const folders = getFoldersWithFiles(selectedFiles);
	const folderHashes: Record<string, string> = {};
	for (const folder of folders)
		folderHashes[folder] = await computeFolderHash(folder, fileHashes);

	const state: CodemapState = {
		file_hashes: fileHashes,
		folder_hashes: folderHashes,
		metadata: {
			exceptions,
			exclude_patterns: excludePatterns,
			include_patterns: includePatterns,
			last_run: new Date().toISOString(),
			root,
			version: VERSION,
		},
	};

	return { folders, state };
}

export async function cmdInit(options: CommandOptions & { root: string }): Promise<number> {
	const resolvedRoot = path.resolve(options.root);
	if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) {
		console.error(`Error: ${resolvedRoot} is not a directory`);
		return 1;
	}

	const includePatterns = options.include.length ? options.include : ['**/*'];
	const excludePatterns = options.exclude;
	const exceptions = options.exception;
	const gitignore = await loadGitignore(resolvedRoot);

	console.log(`Scanning ${resolvedRoot}...`);
	console.log(`Include patterns: ${JSON.stringify(includePatterns)}`);
	console.log(`Exclude patterns: ${JSON.stringify(excludePatterns)}`);
	console.log(`Exceptions: ${JSON.stringify(exceptions)}`);

	const selectedFiles = await selectFiles(
		resolvedRoot,
		includePatterns,
		excludePatterns,
		exceptions,
		gitignore,
	);

	console.log(`Selected ${selectedFiles.length} files`);

	const { state, folders } = await buildState(
		resolvedRoot,
		includePatterns,
		excludePatterns,
		exceptions,
		selectedFiles,
	);

	await saveState(resolvedRoot, state);
	console.log(`Created ${STATE_DIR}/${STATE_FILE}`);

	for (const folder of folders) {
		const folderPath = folder === '.' ? resolvedRoot : path.join(resolvedRoot, folder);
		const folderName = folder === '.' ? path.basename(resolvedRoot) : folder;
		await createEmptyCodemap(folderPath, folderName);
	}

	console.log(`Created ${folders.size} empty codemap.md files`);
	return 0;
}

export async function cmdChanges(options: CommandOptions & { root: string }): Promise<number> {
	const resolvedRoot = path.resolve(options.root);
	const state = await loadState(resolvedRoot);
	if (!state) {
		console.error("No codemap state found. Run 'init' first.");
		return 1;
	}

	const metadata = state.metadata;
	const includePatterns = metadata.include_patterns ?? ['**/*'];
	const excludePatterns = metadata.exclude_patterns ?? [];
	const exceptions = metadata.exceptions ?? [];
	const gitignore = await loadGitignore(resolvedRoot);

	const currentFiles = await selectFiles(
		resolvedRoot,
		includePatterns,
		excludePatterns,
		exceptions,
		gitignore,
	);

	const hashPromises = currentFiles.map(async (relPath) => {
		const hash = await computeFileHash(resolvedRoot, relPath);
		return [relPath, hash] as const;
	});
	const results = await Promise.all(hashPromises);
	const currentHashes = Object.fromEntries(results);

	const savedHashes = state.file_hashes ?? {};
	const currentPaths = new Set(Object.keys(currentHashes));
	const savedPaths = new Set(Object.keys(savedHashes));

	const added = [...currentPaths].filter((filePath) => !savedPaths.has(filePath)).sort();
	const removed = [...savedPaths].filter((filePath) => !currentPaths.has(filePath)).sort();
	const modified = [...currentPaths]
		.filter((filePath) => savedPaths.has(filePath))
		.filter((filePath) => currentHashes[filePath] !== savedHashes[filePath])
		.sort();

	if (!added.length && !removed.length && !modified.length) {
		console.log('No changes detected.');
		return 0;
	}

	if (added.length) {
		console.log(`\n${added.length} added:`);
		for (const filePath of added) console.log(`  + ${filePath}`);
	}

	if (removed.length) {
		console.log(`\n${removed.length} removed:`);
		for (const filePath of removed) console.log(`  - ${filePath}`);
	}

	if (modified.length) {
		console.log(`\n${modified.length} modified:`);
		for (const filePath of modified) console.log(`  ~ ${filePath}`);
	}

	const affectedFolders = new Set<string>(['.']);
	for (const filePath of [...added, ...removed, ...modified]) {
		const parts = filePath.split('/').slice(0, -1);
		for (let i = 0; i < parts.length; i++) affectedFolders.add(parts.slice(0, i + 1).join('/'));
	}

	const sortedFolders = [...affectedFolders].sort();
	console.log(`\n${sortedFolders.length} folders affected:`);
	for (const folder of sortedFolders) console.log(`  ${folder}/`);

	return 0;
}

export async function cmdUpdate(options: CommandOptions & { root: string }): Promise<number> {
	const resolvedRoot = path.resolve(options.root);
	const state = await loadState(resolvedRoot);
	if (!state) {
		console.error("No codemap state found. Run 'init' first.");
		return 1;
	}

	const metadata = state.metadata;
	const includePatterns = metadata.include_patterns ?? ['**/*'];
	const excludePatterns = metadata.exclude_patterns ?? [];
	const exceptions = metadata.exceptions ?? [];
	const gitignore = await loadGitignore(resolvedRoot);

	const selectedFiles = await selectFiles(
		resolvedRoot,
		includePatterns,
		excludePatterns,
		exceptions,
		gitignore,
	);

	const { state: nextState } = await buildState(
		resolvedRoot,
		includePatterns,
		excludePatterns,
		exceptions,
		selectedFiles,
	);

	await saveState(resolvedRoot, nextState);
	console.log(`Updated ${STATE_DIR}/${STATE_FILE} with ${selectedFiles.length} files`);
	return 0;
}

export function parseArgs(argv: Array<string>): { command: string; options: CommandOptions } {
	const [command, ...rest] = argv;
	const options: CommandOptions = {
		exception: [],
		exclude: [],
		include: [],
	};

	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		const value = rest[i + 1];

		if (!arg?.startsWith('--')) continue;
		if (value === undefined || value.startsWith('--'))
			throw new Error(`Missing value for ${arg}`);

		const key = arg.slice(2);
		if (key === 'include' || key === 'exclude' || key === 'exception') options[key].push(value);
		else if (key === 'root') options.root = value;
		else throw new Error(`Unknown option: ${arg}`);

		i++;
	}

	return { command: command ?? '', options };
}

export async function main(argv: Array<string> = process.argv.slice(2)): Promise<number> {
	try {
		const { command, options } = parseArgs(argv);

		if (!command || !options.root) {
			console.error(
				'Usage: codemap.ts <init|changes|update> --root /path [--include glob] [--exclude glob] [--exception path]',
			);
			return 1;
		}

		const typedOptions = options as CommandOptions & { root: string };

		if (command === 'init') return await cmdInit(typedOptions);
		if (command === 'changes') return await cmdChanges(typedOptions);
		if (command === 'update') return await cmdUpdate(typedOptions);

		console.error(`Unknown command: ${command}`);
		return 1;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

const currentFilePath = import.meta.path;
if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath)
	void main().then((code) => process.exit(code));

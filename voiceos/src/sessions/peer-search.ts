// search_files: Voice OS's own search over a session's folders. Claude Code no longer ships Grep or
// Glob as tools (its search runs through Bash), and the read-only copy that answers another
// session's ask may not run Bash, so the copy searches with this instead. Read-only, inside the
// session's roots, never a secret, never a binary.
import type { Dirent } from 'node:fs';
import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { isSecretPath, resolveInsideRoots, type SessionRoots } from './peer-paths.js';

// On the voiceos MCP server, beside the peer tools (session-ask-tools.ts).
export const SEARCH_TOOL = 'mcp__voiceos__search_files';

const SKIPPED_DIRS = new Set([
	'.git',
	'node_modules',
	'dist',
	'build',
	'.next',
	'.turbo',
	'.venv',
	'venv',
	'__pycache__',
	'target',
	'coverage',
	'.cache',
]);
const MAX_FILE_BYTES = 1_000_000;
const MAX_WALKED = 20_000;
const MAX_MATCHES = 100;
const MAX_LISTED = 200;
const MAX_LINE_CHARS = 200;
const BINARY_SNIFF_BYTES = 8_000;
// A longer line (minified code, a one-line JSON dump) is never tested: the regex runs on Voice OS's
// own event loop, so neither a long line nor a long search may hold it.
const MAX_TESTED_LINE = 2_000;
const MAX_SEARCH_MS = 5_000;

export interface SearchParams {
	// A regex over each line; searched as plain text when it is not a valid one, repeats a group or
	// has a backreference. Lines over 2000 characters are skipped.
	pattern?: string;
	// A filename wildcard ("*.jsonl", "phone_speak*"); alone, it lists files.
	name?: string;
	// Where to start, inside the session's folders; the worktree when left out.
	path?: string;
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A repeated group ("(a+)+", "(a|aa)*", "(x){2,}") or a backreference can take exponential time on
// one line, and JavaScript has no linear-time regex: such a pattern is searched as plain text. A
// search for code rarely needs one. Stacked quantifiers without a group ("\s*\s*\s*x") stay
// polynomial on a capped line: an accepted risk, since a copy's searches are short literals.
const RISKY_PATTERN = /\)[+*{]|\\[1-9]/;

// Case-insensitive unless it has a capital, as ripgrep's smart case does. Invalid or risky → as text.
export const toLineRegex = (pattern: string): RegExp => {
	const flags = /[A-Z]/.test(pattern) ? '' : 'i';

	if (RISKY_PATTERN.test(pattern)) {
		return new RegExp(escapeRegex(pattern), flags);
	}

	try {
		return new RegExp(pattern, flags);
	} catch {
		return new RegExp(escapeRegex(pattern), flags);
	}
};

export const toNameRegex = (name: string): RegExp =>
	new RegExp(`^${name.split('*').map(escapeRegex).join('.*').replace(/\\\?/g, '.')}$`, 'i');

const isBinary = (bytes: Uint8Array): boolean => bytes.includes(0);

// Opened without following a link: a file swapped for one after the walk saw it is never read.
const readText = async (path: string): Promise<string | null> => {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

	try {
		if ((await handle.stat()).size > MAX_FILE_BYTES) {
			return null;
		}

		const content = await handle.readFile();

		return isBinary(content.subarray(0, BINARY_SNIFF_BYTES)) ? null : content.toString('utf8');
	} finally {
		await handle.close();
	}
};

const readEntries = async (dir: string): Promise<Dirent[]> => {
	try {
		return await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
};

// Every file under start, depth first and in name order, without what is never searched. A link is
// neither a file nor a folder here, so it is never followed out of the roots. A secret is judged
// below the start, as relativeToRoot judges the start.
async function* walk(
	start: string,
	base: string,
	budget: { left: number },
): AsyncGenerator<string> {
	const entries = (await readEntries(start)).sort((left, right) =>
		left.name.localeCompare(right.name),
	);

	for (const entry of entries) {
		if (budget.left <= 0) {
			return;
		}

		const path = join(start, entry.name);

		if (isSecretPath(relative(base, path))) {
			continue;
		}

		if (entry.isDirectory()) {
			if (!SKIPPED_DIRS.has(entry.name)) {
				yield* walk(path, base, budget);
			}
		} else if (entry.isFile()) {
			budget.left--;
			yield path;
		}
	}
}

// The start as seen from the root it is in: a secret is judged below the root, so a worktree inside a
// folder named "secret-…" is still searched.
const relativeToRoot = async (start: string, { cwd, dirs }: SessionRoots): Promise<string> => {
	for (const root of [cwd, ...dirs]) {
		const rel = relative(await realpath(root).catch(() => root), start);

		if (!rel.startsWith('..')) {
			return rel;
		}
	}

	return start;
};

const shorten = (line: string): string =>
	line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;

export const searchFiles = async (params: SearchParams, roots: SessionRoots): Promise<string> => {
	const { pattern, name, path } = params;

	if (!pattern && !name) {
		return 'Give a pattern to search for, a name to list files by, or both.';
	}

	const start = resolveInsideRoots(path ?? roots.cwd, roots);

	if (!start) {
		return `${path} is outside your folders.`;
	}

	if (isSecretPath(await relativeToRoot(start, roots))) {
		return `${path ?? start} is a secret: it is never searched here.`;
	}

	const startInfo = await stat(start).catch(() => null);

	if (!startInfo) {
		return `${path} does not exist.`;
	}

	// Walked paths are real ones (a /tmp worktree is /private/tmp on a Mac): shown from the real cwd.
	const base = await realpath(roots.cwd).catch(() => roots.cwd);
	// Inside the worktree, relative; elsewhere (the memory folder) absolute, as Read takes it.
	const shown = (file: string): string => {
		const rel = relative(base, file);

		return rel && !rel.startsWith('..') ? rel : file;
	};
	const deadline = Date.now() + MAX_SEARCH_MS;
	const nameRegex = name ? toNameRegex(name) : null;
	const lineRegex = pattern ? toLineRegex(pattern) : null;
	const budget = { left: MAX_WALKED };
	const files = startInfo.isFile() ? [start] : walk(start, start, budget);
	const found: string[] = [];
	let isCut = false;

	for await (const file of files) {
		if (Date.now() > deadline) {
			isCut = true;
			break;
		}

		if (nameRegex && !nameRegex.test(file.split('/').at(-1) ?? '')) {
			continue;
		}

		if (!lineRegex) {
			if (found.length >= MAX_LISTED) {
				isCut = true;
				break;
			}

			found.push(shown(file));
			continue;
		}

		const text = await readText(file).catch(() => null);

		if (text === null) {
			continue;
		}

		const lines = text.split('\n');

		for (const [index, line] of lines.entries()) {
			if (line.length <= MAX_TESTED_LINE && lineRegex.test(line)) {
				if (found.length >= MAX_MATCHES) {
					isCut = true;
					break;
				}

				found.push(`${shown(file)}:${index + 1}: ${shorten(line.trim())}`);
			}
		}

		if (isCut) {
			break;
		}
	}

	if (budget.left <= 0) {
		isCut = true;
	}

	if (found.length === 0) {
		return isCut ? 'Nothing found in the files searched; narrow it with path.' : 'Nothing found.';
	}

	return isCut
		? [...found, '… stopped early: narrow it with path or name.'].join('\n')
		: found.join('\n');
};

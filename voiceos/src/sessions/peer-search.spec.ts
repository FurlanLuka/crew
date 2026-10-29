import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchFiles, toLineRegex, toNameRegex } from './peer-search.js';

const made: string[] = [];

afterEach(() => {
	for (const dir of made.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

// A worktree with what a search finds and what it must never show.
const makeTree = () => {
	const home = mkdtempSync(join(tmpdir(), 'peer-search-'));
	const cwd = join(home, 'checkout');
	made.push(home);

	const write = (path: string, content: string | Uint8Array) => {
		mkdirSync(join(cwd, path, '..'), { recursive: true });
		writeFileSync(join(cwd, path), content);
	};

	write('src/retry.ts', 'export const RETRY_LIMIT = 3;\nconst backoff = 200;\n');
	write('datasets/phone_speak.jsonl', '{"id":"discussion-progression-ja"}\n{"id":"other"}\n');
	write('.env', 'RETRY_LIMIT_KEY=hunter2\n');
	write('config/client_secret.json', '{"retry_limit": 1}\n');
	write('.git/config', 'retry_limit = 9\n');
	write('node_modules/lib/index.js', 'RETRY_LIMIT\n');
	// A NUL makes it binary: its RETRY_LIMIT is never shown.
	write('logo.png', new Uint8Array([0, 1, 2, ...new TextEncoder().encode('\nRETRY_LIMIT\n')]));
	// A secret folder with a harmless file name: pruned as a folder, not by the name.
	write('deploy/.ssh/known_hosts', 'retry_limit\n');

	return { home, cwd, roots: { cwd, dirs: [] } };
};

describe('searchFiles', () => {
	it('a pattern → each matching line with its file and line, secrets and build dirs left out', async () => {
		const { roots } = makeTree();

		expect(await searchFiles({ pattern: 'retry_limit' }, roots)).toBe(
			'src/retry.ts:1: export const RETRY_LIMIT = 3;',
		);
	});

	it('a capital makes it match case', async () => {
		const { roots } = makeTree();

		expect(await searchFiles({ pattern: 'Retry' }, roots)).toBe('Nothing found.');
	});

	it('a pattern that is not a valid regex is searched as text', async () => {
		const { roots } = makeTree();

		expect(await searchFiles({ pattern: '"id":"discussion-progression-ja"}(' }, roots)).toBe(
			'Nothing found.',
		);
		expect(await searchFiles({ pattern: 'discussion-progression-ja"}' }, roots)).toBe(
			'datasets/phone_speak.jsonl:1: {"id":"discussion-progression-ja"}',
		);
	});

	it('a name alone lists the files it matches; with a pattern it narrows the search', async () => {
		const { roots } = makeTree();

		expect(await searchFiles({ name: '*.jsonl' }, roots)).toBe('datasets/phone_speak.jsonl');
		expect(await searchFiles({ name: '*.ts', pattern: 'backoff' }, roots)).toBe(
			'src/retry.ts:2: const backoff = 200;',
		);
	});

	it('a path narrows it; outside the folders, or a secret, it is refused', async () => {
		const { home, cwd, roots } = makeTree();

		expect(await searchFiles({ pattern: 'id', path: join(cwd, 'datasets') }, roots)).toBe(
			'datasets/phone_speak.jsonl:1: {"id":"discussion-progression-ja"}\ndatasets/phone_speak.jsonl:2: {"id":"other"}',
		);
		expect(await searchFiles({ pattern: 'x', path: home }, roots)).toBe(
			`${home} is outside your folders.`,
		);
		expect(await searchFiles({ pattern: 'x', path: '.env' }, roots)).toBe(
			'.env is a secret: it is never searched here.',
		);
	});

	it('a worktree inside a folder named like a secret is still searched', async () => {
		const home = mkdtempSync(join(tmpdir(), 'secret-'));
		made.push(home);
		writeFileSync(join(home, 'a.txt'), 'found me\n');

		expect(await searchFiles({ pattern: 'found' }, { cwd: home, dirs: [] })).toBe(
			'a.txt:1: found me',
		);
	});

	it('too many matches → the first hundred and a line saying it stopped', async () => {
		const { cwd, roots } = makeTree();
		writeFileSync(join(cwd, 'many.txt'), 'hit\n'.repeat(150));

		const lines = (await searchFiles({ pattern: 'hit', name: 'many.txt' }, roots)).split('\n');

		expect(lines).toHaveLength(101);
		expect(lines.at(-1)).toBe('… stopped early: narrow it with path or name.');
	});

	it('a listing over two hundred files → the first two hundred and a line saying it stopped', async () => {
		const { cwd, roots } = makeTree();
		mkdirSync(join(cwd, 'many'));
		for (let index = 0; index < 210; index++) {
			writeFileSync(join(cwd, 'many', `f${index}.txt`), '');
		}

		const lines = (await searchFiles({ name: 'f*.txt' }, roots)).split('\n');

		expect(lines).toHaveLength(201);
		expect(lines.at(-1)).toBe('… stopped early: narrow it with path or name.');
	});

	it('nothing to search for → says what it takes', async () => {
		const { roots } = makeTree();

		expect(await searchFiles({}, roots)).toBe(
			'Give a pattern to search for, a name to list files by, or both.',
		);
	});
});

describe('links and secrets', () => {
	it('a link in the tree, to a file outside, to a secret or to a folder outside → never searched or listed', async () => {
		const { home, cwd, roots } = makeTree();
		const before = {
			search: await searchFiles({ pattern: 'retry_limit' }, roots),
			list: await searchFiles({ name: '*' }, roots),
		};

		writeFileSync(join(home, 'outside.txt'), 'retry_limit outside\n');
		mkdirSync(join(home, 'other-worktree'));
		writeFileSync(join(home, 'other-worktree', 'a.ts'), 'retry_limit elsewhere\n');
		symlinkSync(join(home, 'outside.txt'), join(cwd, 'notes.txt'));
		symlinkSync(join(cwd, '.env'), join(cwd, 'config.txt'));
		symlinkSync(join(home, 'other-worktree'), join(cwd, 'vendor'));

		expect(await searchFiles({ pattern: 'retry_limit' }, roots)).toBe(before.search);
		expect(await searchFiles({ name: '*' }, roots)).toBe(before.list);
	});

	it('a start path through a link: to a secret it is refused, to a folder outside it is outside', async () => {
		const { home, cwd, roots } = makeTree();
		mkdirSync(join(home, 'other-worktree'));
		symlinkSync(join(cwd, '.env'), join(cwd, 'config.txt'));
		symlinkSync(join(home, 'other-worktree'), join(cwd, 'vendor'));

		expect(await searchFiles({ pattern: 'x', path: 'config.txt' }, roots)).toBe(
			'config.txt is a secret: it is never searched here.',
		);
		expect(await searchFiles({ pattern: 'x', path: 'vendor' }, roots)).toBe(
			'vendor is outside your folders.',
		);
	});

	it('a file in another root (the memory folder) comes back absolute, as Read takes it', async () => {
		const { home, roots } = makeTree();
		const memory = join(home, 'memory');
		mkdirSync(memory);
		writeFileSync(join(memory, 'notes.md'), 'discussion rows live in phone_speak\n');

		expect(
			await searchFiles({ pattern: 'discussion rows', path: memory }, { ...roots, dirs: [memory] }),
		).toMatch(/^\/.*\/memory\/notes\.md:1: discussion rows live in phone_speak$/);
	});
});

describe('patterns that could hold Voice OS', () => {
	it('a repeated group is searched as plain text, and returns at once on a long line', async () => {
		const { cwd, roots } = makeTree();
		writeFileSync(join(cwd, 'long.txt'), `${'a'.repeat(1_500)}b\n`);
		const startedAt = Date.now();

		expect(await searchFiles({ pattern: '(a+)+$', name: 'long.txt' }, roots)).toBe(
			'Nothing found.',
		);
		expect(Date.now() - startedAt).toBeLessThan(1_000);
	});

	it('a line longer than the cap (minified code) is never tested', async () => {
		const { cwd, roots } = makeTree();
		writeFileSync(join(cwd, 'bundle.min.js'), `${'x'.repeat(3_000)}needle\n`);

		expect(await searchFiles({ pattern: 'needle' }, roots)).toBe('Nothing found.');
	});
});

describe('the patterns', () => {
	it('a repeated group or a backreference → plain text; a plain repeat stays a regex', () => {
		expect(toLineRegex('(a+)+$').source).toBe('\\(a\\+\\)\\+\\$');
		expect(toLineRegex('(\\w)\\1').source).toBe('\\(\\\\w\\)\\\\1');
		expect(toLineRegex('retry_\\w+').source).toBe('retry_\\w+');
	});

	it('smart case, as ripgrep does', () => {
		expect(toLineRegex('retry').flags).toBe('i');
		expect(toLineRegex('Retry').flags).toBe('');
	});

	it('a name wildcard matches whole names only', () => {
		expect(toNameRegex('*.jsonl').test('phone_speak.jsonl')).toBe(true);
		expect(toNameRegex('*.jsonl').test('phone_speak.jsonl.bak')).toBe(false);
		expect(toNameRegex('phone_?peak*').test('phone_speak.jsonl')).toBe(true);
	});
});

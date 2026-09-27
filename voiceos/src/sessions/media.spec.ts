import { afterAll, describe, expect, it } from 'bun:test';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
	MAX_IMAGE_BYTES,
	copyShownImage,
	findShownImages,
	listImageRoots,
	readMediaFile,
	saveToolImage,
	sweepMedia,
	type ImageSource,
} from './media.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const made: string[] = [];

const makeDir = (prefix: string): string => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.push(dir);

	return dir;
};

afterAll(() => {
	for (const dir of made) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('findShownImages', () => {
	it.each([
		[
			'a Markdown image',
			'Here: ![the login page](shots/login.png)',
			[{ path: 'shots/login.png', alt: 'the login page' }],
		],
		[
			'a bare path with a folder',
			'Saved it to ./out/chart.webp for you.',
			[{ path: './out/chart.webp', alt: '' }],
		],
		[
			'an absolute path in backticks',
			'See `/w/store/diagram.jpeg`.',
			[{ path: '/w/store/diagram.jpeg', alt: '' }],
		],
		['the same path twice', '![a](x/y.png) and again x/y.png', [{ path: 'x/y.png', alt: 'a' }]],
		[
			'a bare file name in prose: talk about a file, not showing it',
			'I deleted the old logo.png; hero.jpg is too big.',
			[],
		],
		['a remote image', '![logo](https://example.com/logo.png)', []],
		['no image', 'The tests pass; see src/app.ts.', []],
	])('%s', (_label, text, expected) => {
		expect(findShownImages(text)).toEqual(expected);
	});

	it('a long run of word characters costs no more than a pass over it', () => {
		const token = `${'a'.repeat(50_000)} ${'b/'.repeat(10_000)}c`;
		const startedAt = performance.now();

		findShownImages(token);

		expect(performance.now() - startedAt).toBeLessThan(200);
	});
});

describe('saveToolImage', () => {
	it('stores by content: the same screenshot twice is one file, its age counted from the last showing', () => {
		const dir = makeDir('media-');
		const data = PNG.toString('base64');

		const first = saveToolImage({ data, mediaType: 'image/png', dir });
		const name = first.ok ? first.name : '';
		utimesSync(join(dir, name), new Date(1_000), new Date(1_000));
		const second = saveToolImage({ data, mediaType: 'image/png', dir });

		expect(first).toEqual(second);
		expect(name).toMatch(/^[0-9a-f]{32}\.png$/);
		expect(readdirSync(dir)).toEqual([name]);
		expect(statSync(join(dir, name)).mtimeMs).toBeGreaterThan(1_000_000);
	});

	it.each([
		['an SVG (it can carry script)', '<svg onload="alert(1)"/>', 'image/svg+xml'],
		['HTML', '<html>', 'text/html'],
		['empty', '', 'image/png'],
		['a PNG type over bytes that are not one', 'hello', 'image/png'],
	])('refuses %s, writing nothing', (_label, raw, mediaType) => {
		const dir = makeDir('media-');

		expect(saveToolImage({ data: Buffer.from(raw).toString('base64'), mediaType, dir })).toEqual({
			ok: false,
			reason: 'not an image',
		});
		expect(readdirSync(dir)).toEqual([]);
	});

	it('refuses an image over the size cap, writing nothing', () => {
		const dir = makeDir('media-');
		const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]);

		expect(saveToolImage({ data: big.toString('base64'), mediaType: 'image/png', dir })).toEqual({
			ok: false,
			reason: 'too big',
		});
		expect(readdirSync(dir)).toEqual([]);
	});
});

describe('copyShownImage', () => {
	const setup = () => {
		const root = makeDir('worktree-');
		const second = makeDir('worktree-second-');
		const outside = makeDir('outside-');
		const media = makeDir('media-');

		mkdirSync(join(root, 'shots'));
		mkdirSync(join(root, 'dir.png'));
		writeFileSync(join(root, 'shots', 'ok.png'), PNG);
		writeFileSync(join(second, 'api.png'), PNG);
		writeFileSync(join(root, 'fake.png'), '<script>alert(1)</script>');
		writeFileSync(join(root, 'notes.txt'), 'hello');
		writeFileSync(join(outside, 'secret.png'), PNG);
		symlinkSync(join(outside, 'secret.png'), join(root, 'link.png'));
		const session: ImageSource = { cwd: root, dirs: [second], isPinned: false };

		return { root, second, outside, media, session };
	};

	it('copies an image inside the worktree into the media folder, relative or absolute', () => {
		const { root, media, session } = setup();

		const relative = copyShownImage({ path: 'shots/ok.png', session, dir: media });
		const absolute = copyShownImage({ path: join(root, 'shots', 'ok.png'), session, dir: media });

		expect(relative.ok).toBe(true);
		expect(absolute).toEqual(relative);
		expect(readdirSync(media)).toHaveLength(1);
	});

	it("an image in another of the worktree's project folders → copied", () => {
		const { second, media, session } = setup();

		expect(copyShownImage({ path: join(second, 'api.png'), session, dir: media }).ok).toBe(true);
	});

	it.each([
		['a symlink pointing out', 'link.png', 'outside'],
		['a file that is not there', 'shots/none.png', 'missing'],
		['a text file', 'notes.txt', 'not an image'],
		['a .png that is not a PNG', 'fake.png', 'not an image'],
		['a folder named like an image', 'dir.png', 'not an image'],
	])('refuses %s, copying nothing', (_label, path, reason) => {
		const { media, session } = setup();

		expect(copyShownImage({ path, session, dir: media })).toEqual({ ok: false, reason } as never);
		expect(readdirSync(media)).toEqual([]);
	});

	it('refuses a path climbing out, and an absolute one outside', () => {
		const { outside, media, session } = setup();

		expect(
			copyShownImage({ path: join('..', basename(outside), 'secret.png'), session, dir: media }),
		).toEqual({ ok: false, reason: 'outside' });
		expect(copyShownImage({ path: join(outside, 'secret.png'), session, dir: media })).toEqual({
			ok: false,
			reason: 'outside',
		});
	});

	it('the setup session, whose folder is home, shows nothing from it', () => {
		const { root, media } = setup();
		const setupSession: ImageSource = { cwd: root, dirs: [], isPinned: true };

		expect(listImageRoots(setupSession)).toEqual([]);
		expect(copyShownImage({ path: 'shots/ok.png', session: setupSession, dir: media })).toEqual({
			ok: false,
			reason: 'outside',
		});
	});

	it('~/ is the home folder: inside the worktree → copied, elsewhere → outside', () => {
		const { root, outside, media, session } = setup();
		const savedHome = process.env.HOME;

		try {
			process.env.HOME = root;
			expect(copyShownImage({ path: '~/shots/ok.png', session, dir: media }).ok).toBe(true);
			process.env.HOME = outside;
			expect(copyShownImage({ path: '~/secret.png', session, dir: media })).toEqual({
				ok: false,
				reason: 'outside',
			});
		} finally {
			process.env.HOME = savedHome;
		}
	});

	it('an unreadable image is refused, never thrown out of the stream', () => {
		const { root, media, session } = setup();
		const locked = join(root, 'shots', 'locked.png');

		writeFileSync(locked, PNG);
		chmodSync(locked, 0o000);

		try {
			expect(copyShownImage({ path: 'shots/locked.png', session, dir: media })).toEqual({
				ok: false,
				reason: 'missing',
			});
		} finally {
			chmodSync(locked, 0o600);
		}
	});

	it('refuses an image over the size cap', () => {
		const { root, media, session } = setup();
		const big = join(root, 'big.png');

		writeFileSync(big, PNG);
		truncateSync(big, MAX_IMAGE_BYTES + 1);

		expect(copyShownImage({ path: 'big.png', session, dir: media })).toEqual({
			ok: false,
			reason: 'too big',
		});
	});
});

describe('readMediaFile', () => {
	it('a stored image comes back by its name — the round trip the page makes', () => {
		const root = makeDir('worktree-');
		const media = makeDir('media-');
		writeFileSync(join(root, 'a.png'), PNG);
		const stored = copyShownImage({
			path: './a.png',
			session: { cwd: root, dirs: [], isPinned: false },
			dir: media,
		});
		const name = stored.ok ? stored.name : '';

		expect(readMediaFile({ name, dir: media })).toEqual({
			ok: true,
			path: join(media, name),
			contentType: 'image/png',
		});
	});

	it.each([
		['a path climbing out', '../../etc/passwd'],
		['an encoded climb', '..%2Fsecret.png'],
		['a name that is not a content hash', 'shot.png'],
		['an SVG', `${'a'.repeat(32)}.svg`],
		['nothing', ''],
	])('refuses %s', (_label, name) => {
		expect(readMediaFile({ name, dir: makeDir('media-') })).toEqual({
			ok: false,
			reason: 'bad name',
		});
	});

	it('a well-formed name that is not there → missing', () => {
		expect(readMediaFile({ name: `${'a'.repeat(32)}.png`, dir: makeDir('media-') })).toEqual({
			ok: false,
			reason: 'missing',
		});
	});
});

describe('sweepMedia', () => {
	it('removes stored images older than the limit, keeps newer ones and anything else', () => {
		const dir = makeDir('media-');
		const old = join(dir, `${'a'.repeat(32)}.png`);
		const fresh = join(dir, `${'b'.repeat(32)}.png`);
		const other = join(dir, 'README');

		for (const path of [old, fresh, other]) {
			writeFileSync(path, PNG);
		}

		utimesSync(old, new Date(1_000), new Date(1_000));
		utimesSync(other, new Date(1_000), new Date(1_000));

		expect(sweepMedia({ dir, maxAgeMs: 60_000, now: Date.now() })).toBe(1);
		expect(readdirSync(dir).sort()).toEqual([basename(fresh), 'README'].sort());
	});

	it('a write that was never renamed in goes after an hour; a fresh one stays', () => {
		const dir = makeDir('media-');
		const stale = join(dir, `${'c'.repeat(32)}.png.123.tmp`);
		const fresh = join(dir, `${'d'.repeat(32)}.png.456.tmp`);

		writeFileSync(stale, PNG);
		writeFileSync(fresh, PNG);
		utimesSync(stale, new Date(1_000), new Date(1_000));

		expect(sweepMedia({ dir, maxAgeMs: 30 * 24 * 60 * 60 * 1000, now: Date.now() })).toBe(1);
		expect(readdirSync(dir)).toEqual([basename(fresh)]);
	});

	it('no media folder yet → nothing, no error', () => {
		expect(sweepMedia({ dir: join(makeDir('media-'), 'none'), maxAgeMs: 1, now: Date.now() })).toBe(
			0,
		);
	});
});

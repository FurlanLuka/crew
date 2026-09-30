import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import packageJson from '../../package.json';
import {
	ensurePack,
	extractWithTar,
	listPackFiles,
	PACK_MANIFEST,
	type PackEntry,
	packFor,
} from './pack.js';

const PLATFORM = 'linux';
const ID = 'voice-gate-pack-test';

let work: string;
let root: string;

const buildArchive = async (files: string[]): Promise<Uint8Array> => {
	const source = join(work, `source-${files.length}`);

	mkdirSync(source, { recursive: true });

	for (const file of files) {
		writeFileSync(join(source, file), file);
	}

	const archive = join(work, `pack-${files.length}.tar.gz`);
	const tar = Bun.spawn(['tar', '-czf', archive, '-C', source, ...files]);

	await tar.exited;

	return new Uint8Array(readFileSync(archive));
};

const entryFor = (bytes: Uint8Array): PackEntry => ({
	url: 'https://example.test/pack.tar.gz',
	sha256: createHash('sha256').update(bytes).digest('hex'),
});

const serving = (bytes: Uint8Array, status = 200) => {
	const calls: string[] = [];
	const fetchPack = ((url: string) => {
		calls.push(url);

		return Promise.resolve(new Response(Uint8Array.from(bytes), { status }));
	}) as unknown as typeof fetch;

	return { fetchPack, calls };
};

beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), 'voice-gate-pack-'));
	root = join(work, 'voice-gate');
});

afterEach(() => {
	rmSync(work, { recursive: true, force: true });
});

describe('packFor', () => {
	it('each platform a pack is built for → its entry; an Intel Mac → none', () => {
		expect(packFor('darwin', 'arm64')?.url).toContain('darwin_arm64');
		expect(packFor('linux', 'arm64')?.url).toContain('linux_arm64');
		expect(packFor('linux', 'x64')?.url).toContain('linux_x64');
		expect(packFor('darwin', 'x64')).toBeNull();
	});

	it('the manifest’s runtime version → the onnxruntime-node the addon is embedded from', () => {
		expect(PACK_MANIFEST.ortVersion).toBe(packageJson.dependencies['onnxruntime-node']);
	});
});

describe('ensurePack', () => {
	it('nothing installed → downloads, verifies and installs every file', async () => {
		const bytes = await buildArchive(listPackFiles(PLATFORM));
		const { fetchPack } = serving(bytes);
		const pack = await ensurePack({
			root,
			id: ID,
			entry: entryFor(bytes),
			platform: PLATFORM,
			fetch: fetchPack,
		});

		expect(pack).toEqual({ dir: join(root, ID), downloadedBytes: bytes.length });
		expect(readdirSync(pack.dir).sort()).toEqual(listPackFiles(PLATFORM).sort());
		expect(readdirSync(root)).toEqual([ID]);
	});

	it('already installed → not fetched again', async () => {
		const bytes = await buildArchive(listPackFiles(PLATFORM));
		const first = serving(bytes);
		const params = { root, id: ID, entry: entryFor(bytes), platform: PLATFORM } as const;

		await ensurePack({ ...params, fetch: first.fetchPack });

		const second = serving(bytes);
		const pack = await ensurePack({ ...params, fetch: second.fetchPack });

		expect(second.calls).toEqual([]);
		expect(pack.downloadedBytes).toBeNull();
	});

	it('a sha256 the manifest does not pin → refused, nothing left', async () => {
		const bytes = await buildArchive(listPackFiles(PLATFORM));
		const install = ensurePack({
			root,
			id: ID,
			entry: { ...entryFor(bytes), sha256: 'f'.repeat(64) },
			platform: PLATFORM,
			fetch: serving(bytes).fetchPack,
		});

		await expect(install).rejects.toThrow('sha256 mismatch');
		expect(readdirSync(root)).toEqual([]);
	});

	it('the server answers 404 → refused with the status, nothing left', async () => {
		const bytes = await buildArchive(listPackFiles(PLATFORM));
		const install = ensurePack({
			root,
			id: ID,
			entry: entryFor(bytes),
			platform: PLATFORM,
			fetch: serving(bytes, 404).fetchPack,
		});

		await expect(install).rejects.toThrow('404');
		expect(readdirSync(root)).toEqual([]);
	});

	it('the download fails → refused, nothing left', async () => {
		const failing = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
		const install = ensurePack({
			root,
			id: ID,
			entry: { url: 'https://example.test/x', sha256: '0' },
			platform: PLATFORM,
			fetch: failing,
		});

		await expect(install).rejects.toThrow('offline');
		expect(readdirSync(root)).toEqual([]);
	});

	it('an archive with the pinned sha that is not a tarball → refused, nothing left', async () => {
		const bytes = new TextEncoder().encode('not a tarball');
		const install = ensurePack({
			root,
			id: ID,
			entry: entryFor(bytes),
			platform: PLATFORM,
			fetch: serving(bytes).fetchPack,
		});

		await expect(install).rejects.toThrow('tar exited');
		expect(readdirSync(root)).toEqual([]);
	});

	it('an archive missing a model → refused', async () => {
		const bytes = await buildArchive(listPackFiles(PLATFORM).slice(1));
		const install = ensurePack({
			root,
			id: ID,
			entry: entryFor(bytes),
			platform: PLATFORM,
			fetch: serving(bytes).fetchPack,
		});

		await expect(install).rejects.toThrow('lacks');
		expect(readdirSync(root)).toEqual([]);
	});

	it('an install missing a file → counted as not installed, and repaired', async () => {
		const bytes = await buildArchive(listPackFiles(PLATFORM));

		mkdirSync(join(root, ID), { recursive: true });
		writeFileSync(join(root, ID, listPackFiles(PLATFORM)[0] as string), 'partial');

		const pack = await ensurePack({
			root,
			id: ID,
			entry: entryFor(bytes),
			platform: PLATFORM,
			fetch: serving(bytes).fetchPack,
		});

		expect(pack.downloadedBytes).toBe(bytes.length);
		expect(readdirSync(pack.dir)).toHaveLength(listPackFiles(PLATFORM).length);
	});

	it('another Voice OS installs it first → theirs is used, nothing of this one left', async () => {
		const bytes = await buildArchive(listPackFiles(PLATFORM));
		const pack = await ensurePack({
			root,
			id: ID,
			entry: entryFor(bytes),
			platform: PLATFORM,
			fetch: serving(bytes).fetchPack,
			extract: async (archive, into) => {
				await extractWithTar(archive, into);
				// The other install lands between this one's extract and its rename.
				mkdirSync(join(root, ID), { recursive: true });

				for (const file of listPackFiles(PLATFORM)) {
					writeFileSync(join(root, ID, file), 'theirs');
				}
			},
		});

		expect(pack.dir).toBe(join(root, ID));
		expect(readFileSync(join(root, ID, listPackFiles(PLATFORM)[0] as string), 'utf8')).toBe(
			'theirs',
		);
		expect(readdirSync(root)).toEqual([ID]);
	});

	it('an older pack and an old crashed temp → removed; a fresh temp → left alone', async () => {
		const bytes = await buildArchive(listPackFiles(PLATFORM));
		const oldTemp = join(root, '.tmp-crashed');
		const freshTemp = join(root, '.tmp-downloading');

		mkdirSync(join(root, 'voice-gate-pack-0'), { recursive: true });
		mkdirSync(oldTemp, { recursive: true });
		mkdirSync(freshTemp, { recursive: true });

		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);

		utimesSync(oldTemp, twoHoursAgo, twoHoursAgo);
		await ensurePack({
			root,
			id: ID,
			entry: entryFor(bytes),
			platform: PLATFORM,
			fetch: serving(bytes).fetchPack,
		});

		expect(readdirSync(root).sort()).toEqual(['.tmp-downloading', ID]);
	});
});

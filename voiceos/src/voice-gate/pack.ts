// The voice gate's models and the onnxruntime library, one archive per platform, downloaded on the
// first start rather than shipped in every Voice OS build (about 90 MB). Built by
// scripts/voice-gate/build-packs.ts and hosted on a GitHub release of their own, pinned here by
// sha256, so a pack never changes under a Voice OS that trusts it.

import { createHash, randomBytes } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { PACK_FILES, runtimeLibraryName } from './models.js';

export interface PackEntry {
	url: string;
	sha256: string;
}

export interface PackManifest {
	id: string;
	// The runtime library must be the version the embedded addon was built against.
	ortVersion: string;
	platforms: Record<string, PackEntry>;
}

const RELEASE = 'https://github.com/FurlanLuka/crew/releases/download/voice-gate-pack-1';

// No darwin-x64: onnxruntime-node ships no Intel Mac build.
export const PACK_MANIFEST: PackManifest = {
	id: 'voice-gate-pack-1',
	ortVersion: '1.30.0',
	platforms: {
		'darwin-arm64': {
			url: `${RELEASE}/voice-gate-pack-1_darwin_arm64.tar.gz`,
			sha256: '661888fe8603b04873e25b15e67afe5a06f3b94cc20b61d1965dab9bf007dd3f',
		},
		'linux-arm64': {
			url: `${RELEASE}/voice-gate-pack-1_linux_arm64.tar.gz`,
			sha256: 'ac73711ccf9606f5874bdaaa512bcb3522e1dadd9f879a6e15f0ee46c645cee4',
		},
		'linux-x64': {
			url: `${RELEASE}/voice-gate-pack-1_linux_x64.tar.gz`,
			sha256: '22ab882abd0981b40286955aaef5ae3ec0a20a8606550bb87d1d8da5a8e36553',
		},
	},
};

export const packFor = (
	platform: string,
	arch: string,
	manifest: PackManifest = PACK_MANIFEST,
): PackEntry | null => manifest.platforms[`${platform}-${arch}`] ?? null;

export const listPackFiles = (platform: NodeJS.Platform): string[] => [
	PACK_FILES.vad,
	PACK_FILES.ecapa,
	PACK_FILES.ecapaData,
	runtimeLibraryName(platform),
];

const TEMP_PREFIX = '.tmp-';
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
// A younger temp may be another Voice OS downloading right now (a dev build beside the installed one).
const STALE_TEMP_MS = 60 * 60_000;

export type ExtractArchive = (archive: string, into: string) => Promise<void>;

export const extractWithTar: ExtractArchive = async (archive, into) => {
	const tar = Bun.spawn(['tar', '-xzf', archive, '-C', into], { stdout: 'ignore', stderr: 'pipe' });
	const exitCode = await tar.exited;

	if (exitCode !== 0) {
		throw new Error(`tar exited ${exitCode}: ${(await new Response(tar.stderr).text()).trim()}`);
	}
};

export interface EnsurePackParams {
	// Where packs live: one directory per pack id.
	root: string;
	id: string;
	entry: PackEntry;
	platform: NodeJS.Platform;
	fetch: typeof fetch;
	extract?: ExtractArchive;
	onDownload?: () => void;
}

export interface EnsuredPack {
	dir: string;
	downloadedBytes: number | null;
}

const hasPackFiles = (dir: string, platform: NodeJS.Platform): boolean =>
	listPackFiles(platform).every((file) => existsSync(join(dir, file)));

// Leftovers of a crashed download and packs an older Voice OS used.
const removeStale = (root: string, id: string, now: number): void => {
	for (const name of readdirSync(root)) {
		const path = join(root, name);
		const isFreshTemp =
			name.startsWith(TEMP_PREFIX) && now - statSync(path).mtimeMs < STALE_TEMP_MS;

		if (name !== id && !isFreshTemp) {
			rmSync(path, { recursive: true, force: true });
		}
	}
};

const download = async ({
	entry,
	fetch,
}: Pick<EnsurePackParams, 'entry' | 'fetch'>): Promise<Uint8Array> => {
	const response = await fetch(entry.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });

	if (!response.ok) {
		throw new Error(`${entry.url} answered ${response.status}`);
	}

	const bytes = new Uint8Array(await response.arrayBuffer());
	const sha256 = createHash('sha256').update(bytes).digest('hex');

	if (sha256 !== entry.sha256) {
		throw new Error(`sha256 mismatch: got ${sha256}, the manifest pins ${entry.sha256}`);
	}

	return bytes;
};

// Installs the pack unless it is already there, and returns where it is. On any failure nothing is
// left behind; the next start tries again.
export const ensurePack = async ({
	root,
	id,
	entry,
	platform,
	fetch,
	extract = extractWithTar,
	onDownload,
}: EnsurePackParams): Promise<EnsuredPack> => {
	const dir = join(root, id);

	mkdirSync(root, { recursive: true, mode: 0o700 });

	if (hasPackFiles(dir, platform)) {
		return { dir, downloadedBytes: null };
	}

	removeStale(root, id, Date.now());
	rmSync(dir, { recursive: true, force: true });

	// A sibling of the target, so the final rename stays on one filesystem.
	const temp = join(root, `${TEMP_PREFIX}${id}-${randomBytes(4).toString('hex')}`);

	try {
		onDownload?.();

		const bytes = await download({ entry, fetch });
		const archive = join(temp, 'pack.tar.gz');
		const content = join(temp, 'content');

		mkdirSync(content, { recursive: true });
		writeFileSync(archive, bytes);
		await extract(archive, content);

		if (!hasPackFiles(content, platform)) {
			throw new Error(`the archive lacks ${listPackFiles(platform).join(', ')}`);
		}

		try {
			renameSync(content, dir);
		} catch (error) {
			// Another Voice OS installed it first: theirs is as good as this one.
			if (!hasPackFiles(dir, platform)) {
				throw error;
			}
		}

		return { dir, downloadedBytes: bytes.length };
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
};

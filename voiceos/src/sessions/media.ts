import { createHash } from 'node:crypto';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';

// Images a session shows the developer. Every one is copied into Voice OS's own media folder,
// named by its content, and the page loads it from there through /media: the browser never gets
// a path on this machine, a file cannot change between the check and the send, and a name that
// never changes can be cached for good.

const IMAGE_EXTENSION_PATTERN = /\.(?:png|jpe?g|gif|webp)$/i;
// ![alt](path) — a path without spaces, or one in <angle brackets>.
const MARKDOWN_IMAGE_PATTERN =
	/!\[([^\]\n]{0,300})\]\(\s*<?([^)\s>]{1,1000})>?(?:\s+"[^"\n]*")?\s*\)/g;
// A bare path to an image, with at least one directory in it ("shots/login.png", "/w/x/chart.webp"):
// a bare file name in prose ("the old logo.png") is talk about a file, not showing it.
const BARE_IMAGE_PATTERN =
	/(?:^|[\s(`'"])((?:~|\.{1,2})?\/?(?:[\w@.-]+\/)+[\w@-][\w@.-]*\.(?:png|jpe?g|gif|webp))(?=$|[\s)`'",;:!?]|\.(?:\s|$))/gi;
// A stored media file: its content hash and the image's extension, nothing else.
const MEDIA_NAME_PATTERN = /^[0-9a-f]{32}\.(?:png|jpg|gif|webp)$/;
// A write that never got renamed in (Voice OS died between the two).
const PARTIAL_NAME_PATTERN = /^[0-9a-f]{32}\.(?:png|jpg|gif|webp)\.\d+\.tmp$/;
const PARTIAL_KEPT_MS = 60 * 60 * 1000;

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export interface ShownImage {
	path: string;
	alt: string;
}

export const findShownImages = (text: string): ShownImage[] => {
	const found = new Map<string, ShownImage>();

	for (const match of text.matchAll(MARKDOWN_IMAGE_PATTERN)) {
		const path = match[2] ?? '';

		if (IMAGE_EXTENSION_PATTERN.test(path) && !/^[a-z]+:/i.test(path)) {
			found.set(path, { path, alt: (match[1] ?? '').trim() });
		}
	}

	// Paths already taken as Markdown images are not found again bare.
	const withoutMarkdown = text.replace(MARKDOWN_IMAGE_PATTERN, ' ');

	for (const match of withoutMarkdown.matchAll(BARE_IMAGE_PATTERN)) {
		const path = match[1] ?? '';

		if (!found.has(path)) {
			found.set(path, { path, alt: '' });
		}
	}

	return [...found.values()];
};

const EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
	'image/png': '.png',
	'image/jpeg': '.jpg',
	'image/gif': '.gif',
	'image/webp': '.webp',
};

const EXTENSION_BY_FILE: Record<string, string> = {
	'.png': '.png',
	'.jpg': '.jpg',
	'.jpeg': '.jpg',
	'.gif': '.gif',
	'.webp': '.webp',
};

export const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
};

// The image's own first bytes, so a file named .png that is anything else is never served as one.
const matchesMagic = (bytes: Buffer, extension: string): boolean => {
	switch (extension) {
		case '.png':
			return bytes
				.subarray(0, 8)
				.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		case '.jpg':
			return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
		case '.gif':
			return bytes.subarray(0, 4).toString('latin1') === 'GIF8';
		case '.webp':
			return (
				bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
				bytes.subarray(8, 12).toString('latin1') === 'WEBP'
			);
		default:
			return false;
	}
};

export type Refusal = 'outside' | 'missing' | 'not an image' | 'too big';

type Stored = { ok: true; name: string } | { ok: false; reason: Refusal };

// Named by content: the same picture again (a restored history, a second mention) is the same
// file, written once.
const storeImage = (bytes: Buffer, extension: string, dir: string): Stored => {
	if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
		return { ok: false, reason: bytes.length === 0 ? 'not an image' : 'too big' };
	}

	if (!matchesMagic(bytes, extension)) {
		return { ok: false, reason: 'not an image' };
	}

	const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}${extension}`;
	const path = join(dir, name);

	if (existsSync(path)) {
		// Shown again: it is in use, so the sweep counts its age from now.
		const now = new Date();
		utimesSync(path, now, now);
	} else {
		// Written aside and renamed in: a crash mid-write never leaves a torn picture under a
		// good name (a browser would keep it for a year).
		const partial = `${path}.${process.pid}.tmp`;

		mkdirSync(dir, { recursive: true, mode: 0o700 });

		try {
			writeFileSync(partial, bytes, { mode: 0o600 });
			renameSync(partial, path);
		} catch (error) {
			// A full disk leaves no half-written leftover behind.
			rmSync(partial, { force: true });
			throw error;
		}
	}

	return { ok: true, name };
};

interface SaveToolImageParams {
	data: string;
	mediaType: string;
	dir: string;
}

// A screenshot or chart a tool returned, as base64 in its result.
export const saveToolImage = ({ data, mediaType, dir }: SaveToolImageParams): Stored => {
	const extension = EXTENSION_BY_MEDIA_TYPE[mediaType];

	return extension
		? storeImage(Buffer.from(data, 'base64'), extension, dir)
		: { ok: false, reason: 'not an image' };
};

// Where a session's own images may come from.
export interface ImageSource {
	cwd: string;
	dirs: string[];
	isPinned: boolean;
}

// Its worktree. Never the pinned setup session's: its "worktree" is the home folder, and a
// picture from there could be anything on the machine.
export const listImageRoots = (session: ImageSource): string[] =>
	session.isPinned ? [] : [session.cwd, ...session.dirs];

const isInside = (path: string, root: string): boolean => {
	const rel = relative(root, path);

	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const toRealPath = (path: string): string | null => {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
};

interface CopyShownImageParams {
	path: string;
	session: ImageSource;
	dir: string;
}

// An image the session named: inside its worktree once symlinks are followed, then read once and
// stored — what was checked is what is kept.
export const copyShownImage = ({ path, session, dir }: CopyShownImageParams): Stored => {
	const expanded = path.startsWith('~/') ? join(process.env.HOME ?? '', path.slice(2)) : path;
	// A session works inside one project folder or another, and names a file relative to the one
	// it was in: the worktree root first, then each project folder.
	const real =
		[session.cwd, ...session.dirs]
			.map((base) => toRealPath(resolve(base, expanded)))
			.find((candidate): candidate is string => candidate !== null) ?? null;

	if (!real) {
		return { ok: false, reason: 'missing' };
	}

	const roots = listImageRoots(session)
		.map(toRealPath)
		.filter((root): root is string => root !== null);

	if (!roots.some((root) => isInside(real, root))) {
		return { ok: false, reason: 'outside' };
	}

	const extension = EXTENSION_BY_FILE[extname(real).toLowerCase()];

	if (!extension) {
		return { ok: false, reason: 'not an image' };
	}

	let bytes: Buffer;

	// Gone or unreadable meanwhile is a refusal, never an error out of the session's stream.
	try {
		const stat = statSync(real);

		if (!stat.isFile()) {
			return { ok: false, reason: 'not an image' };
		}

		if (stat.size > MAX_IMAGE_BYTES) {
			return { ok: false, reason: 'too big' };
		}

		bytes = readFileSync(real);
	} catch {
		return { ok: false, reason: 'missing' };
	}

	// A failure to store it (a full disk) is the media folder's, and throws for the caller to log.
	return storeImage(bytes, extension, dir);
};

export type MediaFile =
	| { ok: true; path: string; contentType: string }
	| { ok: false; reason: 'bad name' | 'missing' };

interface ReadMediaFileParams {
	name: string;
	dir: string;
}

// What /media may send: a stored image by its exact name, from the media folder alone.
export const readMediaFile = ({ name, dir }: ReadMediaFileParams): MediaFile => {
	if (!MEDIA_NAME_PATTERN.test(name)) {
		return { ok: false, reason: 'bad name' };
	}

	const path = join(dir, name);

	try {
		return lstatSync(path).isFile()
			? { ok: true, path, contentType: CONTENT_TYPE_BY_EXTENSION[extname(name)] ?? 'image/png' }
			: { ok: false, reason: 'missing' };
	} catch {
		return { ok: false, reason: 'missing' };
	}
};

interface SweepMediaParams {
	dir: string;
	maxAgeMs: number;
	now: number;
}

// Old screenshots go; a history that still names one shows it as missing, not as an error.
export const sweepMedia = ({ dir, maxAgeMs, now }: SweepMediaParams): number => {
	let removed = 0;

	let names: string[];

	try {
		names = readdirSync(dir);
	} catch {
		// No media folder yet.
		return 0;
	}

	for (const name of names) {
		const path = join(dir, name);

		// One file gone meanwhile does not end the sweep for the rest.
		try {
			const keptMs = PARTIAL_NAME_PATTERN.test(name) ? PARTIAL_KEPT_MS : maxAgeMs;

			if (
				(MEDIA_NAME_PATTERN.test(name) || PARTIAL_NAME_PATTERN.test(name)) &&
				now - statSync(path).mtimeMs > keptMs
			) {
				rmSync(path, { force: true });
				removed++;
			}
		} catch {
			// Removed by someone else.
		}
	}

	return removed;
};

interface CreateMediaHooksParams {
	session: ImageSource;
	mediaDir: string;
	log?: (message: string, fields: Record<string, unknown>) => void;
}

// What a session can show: images inside its own worktree, and images its tools return. Each
// comes back as its name in the media folder.
export const createMediaHooks = ({ session, mediaDir, log }: CreateMediaHooksParams) => ({
	showImage: (path: string): string | null => {
		try {
			const stored = copyShownImage({ path, session, dir: mediaDir });

			if (!stored.ok) {
				log?.('image not shown', { path, reason: stored.reason });

				return null;
			}

			return stored.name;
		} catch (error) {
			log?.('image not stored', { path, error: String(error) });

			return null;
		}
	},
	saveImage: (data: string, mediaType: string): string | null => {
		try {
			const stored = saveToolImage({ data, mediaType, dir: mediaDir });

			if (!stored.ok) {
				log?.('tool image not saved', { mediaType, reason: stored.reason });

				return null;
			}

			return stored.name;
		} catch (error) {
			log?.('tool image not saved', { mediaType, error: String(error) });

			return null;
		}
	},
});

// Files the developer attached to a session, kept on the machine the session runs on: one folder per
// content hash, the file under its own (made safe) name, so Claude reads it at a plain path and the
// same file attached twice is stored once. The id, `<sha16>/<safe name>`, names it on every machine.
import { createHash } from 'node:crypto';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { MAX_ATTACHMENT_BYTES, TOO_BIG_REASON, type Attachment } from '../shared/protocol.js';
import { IMAGE_EXTENSION_PATTERN, storeAttachedImage } from './media.js';

const ID_PATTERN = /^[0-9a-f]{16}\/[^/\\\0]{1,120}$/u;
const MAX_NAME_CHARS = 120;
// Linux takes 255 bytes a name; this leaves room for the `.part` and `.<pid>.tmp` written beside it.
const MAX_NAME_BYTES = 200;
// A piece of a file on its way to another machine, one link line each: small enough that a slow
// uplink never goes quiet for long.
export const CHUNK_BYTES = 256 * 1024;
// As long as the images sessions show.
export const ATTACHMENTS_KEPT_MS = 30 * 24 * 60 * 60 * 1000;

// A file name that is safe as one path segment: the browser's name, without any folder, control
// character or dot-only name; kept readable (unicode, spaces, commas stay).
export const toSafeName = (name: string): string => {
	const base = name.split(/[\\/]/).at(-1) ?? '';
	const cleaned = [...base]
		.filter((char) => char.charCodeAt(0) >= 0x20 && char !== '\u007f')
		.join('')
		.trim();
	const safe = /^\.*$/.test(cleaned) ? 'file' : cleaned;

	let kept = '';

	for (const char of [...safe].slice(0, MAX_NAME_CHARS)) {
		if (Buffer.byteLength(kept + char) > MAX_NAME_BYTES) {
			break;
		}

		kept += char;
	}

	return kept;
};

export const isAttachmentId = (id: string): boolean =>
	ID_PATTERN.test(id) && !id.endsWith('/.') && !id.endsWith('/..');

const pathOf = (dir: string, id: string): string | null =>
	isAttachmentId(id) ? join(dir, ...id.split('/')) : null;

// Where a stored file is on this machine, or null when it is not here.
export const resolveAttachment = (dir: string, id: string): string | null => {
	const path = pathOf(dir, id);

	return path && existsSync(path) ? path : null;
};

// Its bytes, to send to the machine its session runs on.
export const readAttachmentBytes = (dir: string, id: string): Buffer | null => {
	const path = resolveAttachment(dir, id);

	try {
		return path ? readFileSync(path) : null;
	} catch {
		return null;
	}
};

// Bun's rm throws even forced when the folder above is not one.
const removeQuietly = (path: string): void => {
	try {
		rmSync(path, { force: true });
	} catch {
		// Nothing there to remove.
	}
};

const writeWhole = (path: string, bytes: Buffer): void => {
	// Written aside and renamed in: a crash mid-write never leaves a torn file under its name.
	const partial = `${path}.${process.pid}.tmp`;

	mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });

	try {
		writeFileSync(partial, bytes, { mode: 0o600 });
		renameSync(partial, path);
	} catch (error) {
		removeQuietly(partial);
		throw error;
	}
};

interface StoreAttachmentParams {
	bytes: Buffer;
	name: string;
	mediaType: string;
	dir: string;
	mediaDir: string;
}

export type StoredAttachment = { ok: true; attachment: Attachment } | { ok: false; reason: string };

export const storeAttachment = ({
	bytes,
	name,
	mediaType,
	dir,
	mediaDir,
}: StoreAttachmentParams): StoredAttachment => {
	if (bytes.length === 0) {
		return { ok: false, reason: 'empty file' };
	}

	if (bytes.length > MAX_ATTACHMENT_BYTES) {
		return { ok: false, reason: TOO_BIG_REASON };
	}

	const safe = toSafeName(name);
	const id = `${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}/${safe}`;
	const path = pathOf(dir, id);

	if (!path) {
		return { ok: false, reason: 'unusable file name' };
	}

	if (!existsSync(path)) {
		writeWhole(path, bytes);
	}

	// An image, by its type or else its name (a drop may carry no type), also gets a thumbnail; one the
	// media folder cannot take (an odd format, bytes that are not what they claim) is a file.
	const thumbnail = storeAttachedImage({ bytes, mediaType, fileName: safe, dir: mediaDir });

	return {
		ok: true,
		attachment: {
			id,
			name: safe,
			kind: thumbnail.ok ? 'image' : 'file',
			bytes: bytes.length,
			...(thumbnail.ok ? { mediaName: thumbnail.name } : {}),
		},
	};
};

// Pieces of a file for another machine, in order.
export const toChunks = (bytes: Buffer): string[] => {
	const chunks: string[] = [];

	for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
		chunks.push(bytes.subarray(offset, offset + CHUNK_BYTES).toString('base64'));
	}

	return chunks.length > 0 ? chunks : [''];
};

interface WriteChunkParams {
	dir: string;
	id: string;
	index: number;
	total: number;
	base64: string;
}

// The remote side: pieces arrive in order (the link's outbox keeps them so); the last one renames the
// file in. A file already here, or a piece sent again after a reconnect, changes nothing.
export const writeChunk = ({
	dir,
	id,
	index,
	total,
	base64,
}: WriteChunkParams): 'kept' | 'done' | 'refused' => {
	const path = pathOf(dir, id);

	if (!path || index < 0 || index >= total) {
		return 'refused';
	}

	if (existsSync(path)) {
		return 'done';
	}

	const partial = `${path}.part`;

	// A disk that cannot take it refuses this piece alone: the effects after it still apply.
	try {
		mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });

		// The first piece starts the file over: a transfer cut off midway is sent again from the start.
		if (index === 0) {
			writeFileSync(partial, Buffer.from(base64, 'base64'), { mode: 0o600 });
		} else if (existsSync(partial)) {
			appendFileSync(partial, Buffer.from(base64, 'base64'));
		} else {
			return 'refused';
		}

		if (index === total - 1) {
			renameSync(partial, path);

			return 'done';
		}
	} catch {
		removeQuietly(partial);

		return 'refused';
	}

	return 'kept';
};

interface SweepAttachmentsParams {
	dir: string;
	maxAgeMs: number;
	now: number;
}

// Old attachments go, folder and all, like old media.
export const sweepAttachments = ({ dir, maxAgeMs, now }: SweepAttachmentsParams): number => {
	let removed = 0;
	let folders: string[];

	try {
		folders = readdirSync(dir);
	} catch {
		return 0;
	}

	for (const folder of folders) {
		const path = join(dir, folder);

		try {
			if (/^[0-9a-f]{16}$/.test(folder) && now - statSync(path).mtimeMs > maxAgeMs) {
				rmSync(path, { recursive: true, force: true });
				removed++;
			}
		} catch {
			// Gone meanwhile: the rest are still swept.
		}
	}

	return removed;
};

// What the session's Claude is told with the words: where each file is, one a line (names may hold
// commas and spaces). Read back by history to show the files again.
export const ATTACHED_NOTE_HEAD =
	'(Voice OS note — the developer attached these files; open them with Read:';

export const describeAttached = (paths: string[]): string =>
	[ATTACHED_NOTE_HEAD, ...paths.map((path) => `- ${path}`), ')'].join('\n');

// A prompt read back from the transcript: the developer's words without the note, and the paths it
// listed. The note runs from its head to its closing line (a path may itself hold a parenthesis).
export const splitAttachedNote = (text: string): { text: string; paths: string[] } => {
	const start = text.indexOf(ATTACHED_NOTE_HEAD);

	if (start < 0) {
		return { text, paths: [] };
	}

	const lines = text
		.slice(start + ATTACHED_NOTE_HEAD.length)
		.split('\n')
		.slice(1);
	const end = lines.indexOf(')');
	const listed = end < 0 ? lines : lines.slice(0, end);
	const after = end < 0 ? '' : lines.slice(end + 1).join('\n');

	return {
		text: [text.slice(0, start).trim(), after.trim()].filter(Boolean).join('\n\n'),
		paths: listed.filter((line) => line.startsWith('- ')).map((line) => line.slice(2)),
	};
};

// A file named again from a past turn: its name and kind, no thumbnail (that was this run's).
export const toPastAttachment = (path: string): Attachment => {
	const name = path.split('/').at(-1) ?? path;
	const folder = path.split('/').at(-2) ?? '';

	return {
		id: `${folder}/${name}`,
		name,
		kind: IMAGE_EXTENSION_PATTERN.test(name) ? 'image' : 'file',
		bytes: 0,
	};
};

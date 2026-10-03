import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_ATTACHMENT_BYTES } from '../shared/protocol.js';
import {
	ATTACHED_NOTE_HEAD,
	describeAttached,
	isAttachmentId,
	readAttachmentBytes,
	resolveAttachment,
	splitAttachedNote,
	storeAttachment,
	sweepAttachments,
	toChunks,
	toPastAttachment,
	toSafeName,
	writeChunk,
} from './attachments.js';

let root: string;
let dir: string;
let mediaDir: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'voiceos-attachments-'));
	dir = join(root, 'attachments');
	mediaDir = join(root, 'media');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const store = (bytes: Buffer, name: string, mediaType = 'application/pdf') =>
	storeAttachment({ bytes, name, mediaType, dir, mediaDir });

describe('toSafeName', () => {
	it.each([
		['report.pdf', 'report.pdf'],
		['../../etc/passwd', 'passwd'],
		['C:\\Users\\me\\shot.png', 'shot.png'],
		['..', 'file'],
		['', 'file'],
		['tab\there\u0000.txt', 'tabhere.txt'],
		['naïve résumé, final (2).pdf', 'naïve résumé, final (2).pdf'],
	])('%p → %p', (name, safe) => expect(toSafeName(name)).toBe(safe));

	it('keeps at most 120 characters', () => {
		expect([...toSafeName(`${'é'.repeat(200)}.txt`)]).toHaveLength(120);
	});
});

describe('isAttachmentId', () => {
	it.each([
		['0123456789abcdef/report.pdf', true],
		['0123456789abcdef/..', false],
		['0123456789abcdef/a/b', false],
		['../0123456789abcdef/a', false],
		['0123456789ABCDEF/a', false],
	])('%p → %p', (id, ok) => expect(isAttachmentId(id)).toBe(ok));
});

describe('storeAttachment', () => {
	it('names the file by its content and keeps it under its safe name, readable by id', () => {
		const stored = store(Buffer.from('hello'), '../notes.txt', 'text/plain');

		expect(stored.ok).toBe(true);

		if (!stored.ok) {
			return;
		}

		expect(stored.attachment).toEqual({
			id: `${stored.attachment.id.slice(0, 16)}/notes.txt`,
			name: 'notes.txt',
			kind: 'file',
			bytes: 5,
		});
		expect(readFileSync(resolveAttachment(dir, stored.attachment.id) ?? '', 'utf8')).toBe('hello');
		expect(readAttachmentBytes(dir, stored.attachment.id)?.toString()).toBe('hello');
	});

	it('the same bytes under two names are two files; the same file twice is one', () => {
		const a = store(Buffer.from('same'), 'a.txt');
		const b = store(Buffer.from('same'), 'b.txt');
		const again = store(Buffer.from('same'), 'a.txt');

		expect(a.ok && b.ok && a.attachment.id !== b.attachment.id).toBe(true);
		expect(a.ok && again.ok && a.attachment.id === again.attachment.id).toBe(true);
	});

	it('an image also gets a thumbnail in the media folder', () => {
		const png = Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			Buffer.from('rest'),
		]);
		const stored = store(png, 'shot.png', 'image/png');

		expect(stored.ok && stored.attachment.kind).toBe('image');
		expect(
			stored.ok &&
				Boolean(stored.attachment.mediaName) &&
				existsSync(join(mediaDir, stored.attachment.mediaName ?? '')),
		).toBe(true);
	});

	it('bytes that only claim to be an image are kept as a file', () => {
		const stored = store(Buffer.from('not really a png'), 'shot.png', 'image/png');

		expect(stored.ok && stored.attachment).toMatchObject({ kind: 'file' });
		expect(stored.ok && stored.attachment.mediaName).toBeUndefined();
	});

	it('refuses an empty file and one over 20 MB', () => {
		expect(store(Buffer.alloc(0), 'empty.txt')).toEqual({ ok: false, reason: 'empty file' });
		expect(store(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1), 'big.bin')).toEqual({
			ok: false,
			reason: 'over 20 MB',
		});
	});

	it('a file not here resolves to nothing', () => {
		expect(resolveAttachment(dir, '0123456789abcdef/missing.txt')).toBeNull();
		expect(resolveAttachment(dir, '../../etc/passwd')).toBeNull();
	});
});

describe('chunks to another machine', () => {
	const ID = '0123456789abcdef/big.bin';

	it('reassembled in order into the same bytes', () => {
		const bytes = Buffer.from(Array.from({ length: 600_000 }, (_, index) => index % 251));
		const chunks = toChunks(bytes);
		const outcomes = chunks.map((base64, index) =>
			writeChunk({ dir, id: ID, index, total: chunks.length, base64 }),
		);

		expect(chunks.length).toBe(3);
		expect(outcomes).toEqual(['kept', 'kept', 'done']);
		expect(readAttachmentBytes(dir, ID)?.equals(bytes)).toBe(true);
	});

	it('sent again after a reconnect: a file already here is kept as it is', () => {
		writeChunk({
			dir,
			id: ID,
			index: 0,
			total: 1,
			base64: Buffer.from('first').toString('base64'),
		});

		expect(
			writeChunk({
				dir,
				id: ID,
				index: 0,
				total: 1,
				base64: Buffer.from('other').toString('base64'),
			}),
		).toBe('done');
		expect(readAttachmentBytes(dir, ID)?.toString()).toBe('first');
	});

	it('cut off midway: the first piece starts it over', () => {
		const piece = (text: string) => Buffer.from(text).toString('base64');

		writeChunk({ dir, id: ID, index: 0, total: 2, base64: piece('stale') });
		writeChunk({ dir, id: ID, index: 0, total: 2, base64: piece('ab') });
		writeChunk({ dir, id: ID, index: 1, total: 2, base64: piece('cd') });

		expect(readAttachmentBytes(dir, ID)?.toString()).toBe('abcd');
	});

	it('refuses a piece out of order, a bad index or a bad id', () => {
		expect(writeChunk({ dir, id: ID, index: 1, total: 2, base64: '' })).toBe('refused');
		expect(writeChunk({ dir, id: ID, index: 2, total: 2, base64: '' })).toBe('refused');
		expect(writeChunk({ dir, id: '../x', index: 0, total: 1, base64: '' })).toBe('refused');
	});
});

describe('sweepAttachments', () => {
	it('removes folders older than the limit and keeps the rest', () => {
		const old = store(Buffer.from('old'), 'old.txt');
		const fresh = store(Buffer.from('fresh'), 'fresh.txt');
		const now = Date.now();

		if (!old.ok || !fresh.ok) {
			throw new Error('not stored');
		}

		const oldFolder = join(dir, old.attachment.id.split('/')[0] ?? '');
		utimesSync(oldFolder, new Date(now - 10_000), new Date(now - 10_000));
		writeFileSync(join(dir, 'not-a-hash'), '');

		expect(sweepAttachments({ dir, maxAgeMs: 5_000, now })).toBe(1);
		expect(resolveAttachment(dir, old.attachment.id)).toBeNull();
		expect(resolveAttachment(dir, fresh.attachment.id)).not.toBeNull();
		expect(existsSync(join(dir, 'not-a-hash'))).toBe(true);
	});
});

describe('the note to Claude, and reading it back', () => {
	const paths = ['/h/a/0123456789abcdef/report, final.pdf', '/h/a/fedcba9876543210/shot (1).png'];

	it('one path a line, and history takes it off the words', () => {
		const note = describeAttached(paths);

		expect(note.startsWith(ATTACHED_NOTE_HEAD)).toBe(true);
		expect(splitAttachedNote(`${note}\n\nwhat is wrong here?`)).toEqual({
			text: 'what is wrong here?',
			paths,
		});
	});

	it('words without the note are left alone', () => {
		expect(splitAttachedNote('just words')).toEqual({ text: 'just words', paths: [] });
	});

	it('a past file shows by name, an image as an image, no size kept', () => {
		expect(paths.map(toPastAttachment)).toEqual([
			{
				id: '0123456789abcdef/report, final.pdf',
				name: 'report, final.pdf',
				kind: 'file',
				bytes: 0,
			},
			{ id: 'fedcba9876543210/shot (1).png', name: 'shot (1).png', kind: 'image', bytes: 0 },
		]);
	});
});

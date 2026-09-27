import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GENERAL_NOTES } from '../shared/notes.js';
import { createNotesStore, formatNoteLine } from './notes.js';

const at = new Date(2026, 8, 27, 7, 5);

describe('notes', () => {
	it('one timestamped line per note, per workspace, read back newest last', () => {
		const dir = mkdtempSync(join(tmpdir(), 'notes-'));
		const store = createNotesStore(dir, () => at);

		store.save({ workspace: 'crew', text: 'try a tone\nper session' });
		store.save({ workspace: 'crew', text: 'check the retries' });
		store.save({ workspace: 'store-front', text: 'other' });

		expect(readFileSync(join(dir, 'crew.md'), 'utf8')).toBe(
			'- 2026-09-27 07:05 — try a tone per session\n- 2026-09-27 07:05 — check the retries\n',
		);
		expect(store.read('crew', 1)).toEqual(['- 2026-09-27 07:05 — check the retries']);
		expect(store.read('nothing-yet', 5)).toEqual([]);
	});

	it('a workspace name never escapes the notes folder', () => {
		const dir = mkdtempSync(join(tmpdir(), 'notes-'));
		createNotesStore(dir, () => at).save({ workspace: '../../etc', text: 'x' });

		expect(readFileSync(join(dir, '..-..-etc.md'), 'utf8')).toContain('x');
	});

	it('the line format: one line whatever was said', () =>
		expect(formatNoteLine('  a\n  b ', at)).toBe('- 2026-09-27 07:05 — a b'));

	it('pathFor is where save writes, for a name that needs cleaning and for the general notes', () => {
		const dir = mkdtempSync(join(tmpdir(), 'notes-'));
		const store = createNotesStore(dir, () => at);

		for (const workspace of ['Store Front', GENERAL_NOTES]) {
			expect(store.has(workspace)).toBe(false);
			store.save({ workspace, text: 'x' });
			expect(readFileSync(store.pathFor(workspace), 'utf8')).toBe('- 2026-09-27 07:05 — x\n');
			expect(store.has(workspace)).toBe(true);
		}
	});

	it('readAll: every workspace file, newest lines, anything else in the folder ignored', () => {
		const dir = mkdtempSync(join(tmpdir(), 'notes-'));
		const store = createNotesStore(dir, () => at);

		store.save({ workspace: 'crew', text: 'one' });
		store.save({ workspace: 'crew', text: 'two' });
		store.save({ workspace: GENERAL_NOTES, text: 'loose' });
		writeFileSync(join(dir, 'scratch.txt'), '- not a note\n');

		expect(store.readAll(1)).toEqual({
			crew: ['- 2026-09-27 07:05 — two'],
			[GENERAL_NOTES]: ['- 2026-09-27 07:05 — loose'],
		});
		expect(createNotesStore(join(dir, 'missing')).readAll(5)).toEqual({});
	});
});

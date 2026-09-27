import { describe, expect, it } from 'bun:test';
import {
	GENERAL_NOTES,
	fromNotesFileName,
	readNoteText,
	readWorkspace,
	toNotesFileName,
	toNotesKey,
} from './notes.js';

describe('notes keys', () => {
	it('a ref, a spoken name and the file agree on one key', () => {
		expect(readWorkspace('store-front/main')).toBe('store-front');
		expect(toNotesKey(' Store Front ')).toBe('store-front');
		expect(fromNotesFileName(toNotesFileName('store-front'))).toBe('store-front');
	});

	it('the setup session and none → general, kept apart from a workspace named "general"', () => {
		expect(readWorkspace('setup')).toBe(GENERAL_NOTES);
		expect(readWorkspace(null)).toBe(GENERAL_NOTES);
		expect(toNotesFileName(GENERAL_NOTES)).toBe('_general.md');
		expect(fromNotesFileName('_general.md')).toBe(GENERAL_NOTES);
		expect(fromNotesFileName('notes.txt')).toBeNull();
		expect(readWorkspace('general/main')).not.toBe(GENERAL_NOTES);
		expect(toNotesKey(GENERAL_NOTES)).toBe(GENERAL_NOTES);
		expect(toNotesFileName(readWorkspace('general/main'))).toBe('general.md');
		expect(fromNotesFileName('general.md')).toBe(readWorkspace('general/main'));
	});

	it('a line read aloud loses its stamp', () =>
		expect(readNoteText('- 2026-09-27 07:05 — try a tone')).toBe('try a tone'));
});

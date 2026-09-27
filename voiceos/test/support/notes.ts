import type { NotesStore } from '../../src/memory/notes.js';

// A notes store that keeps nothing: for tests and evals that do not look at notes.
export const createNullNotes = (): NotesStore => ({
	save: () => {
		// Kept nowhere: these tests do not look at notes.
	},
	read: () => [],
	readAll: () => ({}),
	pathFor: (workspace) => `/notes/${workspace}.md`,
	has: () => false,
});

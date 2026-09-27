import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromNotesFileName, toNotesFileName, toNotesKey } from '../shared/notes.js';

// The developer's own notes: ideas and reminders said out loud, one plain Markdown file per
// workspace, nothing captured beside the words. Debug notes are a different thing (debug-notes.ts).

export interface NoteWords {
	// A workspace (any spelling: it is keyed by toNotesKey), or GENERAL_NOTES.
	workspace: string;
	text: string;
}

export interface NotesStore {
	save: (words: NoteWords) => void;
	// Newest last, at most `limit`.
	read: (workspace: string, limit: number) => string[];
	// Every workspace that has notes, each with its newest `limit` lines.
	readAll: (limit: number) => Record<string, string[]>;
	pathFor: (workspace: string) => string;
	has: (workspace: string) => boolean;
}

const pad = (value: number): string => String(value).padStart(2, '0');

export const formatNoteLine = (text: string, at: Date): string => {
	const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;

	// One line per note, whatever was said: a line break would split it in two.
	return `- ${stamp} — ${text.replace(/\s+/g, ' ').trim()}`;
};

const readLines = (file: string): string[] => {
	try {
		return readFileSync(file, 'utf8')
			.split('\n')
			.filter((line) => line.startsWith('- '));
	} catch {
		// No notes yet for this workspace.
		return [];
	}
};

const listFiles = (dir: string): string[] => {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
};

export const createNotesStore = (dir: string, now: () => Date = () => new Date()): NotesStore => {
	const pathFor = (workspace: string): string => join(dir, toNotesFileName(toNotesKey(workspace)));

	return {
		save: ({ workspace, text }) => {
			mkdirSync(dir, { recursive: true });
			appendFileSync(pathFor(workspace), `${formatNoteLine(text, now())}\n`);
		},
		read: (workspace, limit) => readLines(pathFor(workspace)).slice(-limit),
		readAll: (limit) =>
			Object.fromEntries(
				listFiles(dir).flatMap((fileName) => {
					const key = fromNotesFileName(fileName);

					return key ? [[key, readLines(join(dir, fileName)).slice(-limit)]] : [];
				}),
			),
		pathFor,
		has: (workspace) => existsSync(pathFor(workspace)),
	};
};

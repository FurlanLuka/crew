import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HistoryEntry } from '../tools/tools.js';

export type JournalEntry = HistoryEntry & { costUsd: number; head: string | null };

export const resolveJournalFile = (dir: string, ref: string): string => {
	// One append-only JSONL file per session; a changed HEAD between entries shows new commits.
	return join(dir, `${ref.replace(/\//g, '--')}.jsonl`);
};

export const appendJournalEntry = (dir: string, entry: JournalEntry): void => {
	mkdirSync(dir, { recursive: true });
	appendFileSync(resolveJournalFile(dir, entry.ref), `${JSON.stringify(entry)}\n`);
};

const readJournalFile = (file: string): JournalEntry[] => {
	const entries: JournalEntry[] = [];

	for (const line of readFileSync(file, 'utf8').split('\n')) {
		if (!line.trim()) {
			continue;
		}

		try {
			const parsed = JSON.parse(line) as JournalEntry;

			if (typeof parsed.ref === 'string' && typeof parsed.did === 'string') {
				entries.push(parsed);
			}
		} catch {
			// A torn last line from a crash is skipped, never fatal.
		}
	}

	return entries;
};

export interface HistoryQuery {
	ref: string | null;
	query: string | null;
	limit: number;
}

const isMatchingEntry = (entry: JournalEntry, words: string[]): boolean => {
	const haystack = `${entry.asked ?? ''} ${entry.did}`.toLowerCase();

	return words.every((word) => haystack.includes(word));
};

export const readHistory = (dir: string, { ref, query, limit }: HistoryQuery): JournalEntry[] => {
	if (!existsSync(dir)) {
		return [];
	}

	const files = ref
		? [resolveJournalFile(dir, ref)].filter(existsSync)
		: readdirSync(dir)
				.filter((fileName) => fileName.endsWith('.jsonl'))
				.map((fileName) => join(dir, fileName));
	const words = (query ?? '')
		.toLowerCase()
		.split(/\s+/)
		.filter((word) => word.length > 1);

	return files
		.flatMap(readJournalFile)
		.filter((entry) => words.length === 0 || isMatchingEntry(entry, words))
		.sort((left, right) => right.ts.localeCompare(left.ts))
		.slice(0, limit);
};

export const describeTurnOutcome = (spoken: string, text: string): string => {
	// The narrator's line when it spoke, else the opening of what the session wrote.
	if (spoken.trim()) {
		return spoken.trim();
	}

	const firstSentence = text.trim().split(/(?<=[.!?])\s+/)[0] ?? '';

	return firstSentence.length > 200 ? `${firstSentence.slice(0, 199)}…` : firstSentence;
};

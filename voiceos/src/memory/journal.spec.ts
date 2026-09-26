import { describe, expect, it } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInitialState, createSession } from '../state/reducer.js';
import {
	appendJournalEntry,
	describeTurnOutcome,
	resolveJournalFile,
	readHistory,
	type JournalEntry,
} from './journal.js';
import { loadTopics, saveTopics, collectTopics } from './topics.js';

const createDir = () => mkdtempSync(join(tmpdir(), 'voiceos-journal-'));
const createEntry = (ref: string, ts: string, asked: string, did: string): JournalEntry => ({
	ts,
	ref,
	asked,
	did,
	costUsd: 0.01,
	head: null,
});

describe('journal', () => {
	it('append-only: earlier lines are never rewritten', () => {
		const dir = createDir();
		appendJournalEntry(dir, createEntry('store-front/main', '2026-09-24T10:00:00Z', 'a', 'first'));
		const before = readFileSync(resolveJournalFile(dir, 'store-front/main'), 'utf8');
		appendJournalEntry(dir, createEntry('store-front/main', '2026-09-24T11:00:00Z', 'b', 'second'));
		expect(
			readFileSync(resolveJournalFile(dir, 'store-front/main'), 'utf8').startsWith(before),
		).toBe(true);
	});

	it('reads newest first across sessions, limited', () => {
		const dir = createDir();
		appendJournalEntry(dir, createEntry('store-front/main', '2026-09-24T10:00:00Z', 'a', 'one'));
		appendJournalEntry(dir, createEntry('checkout-api/main', '2026-09-24T12:00:00Z', 'b', 'two'));
		appendJournalEntry(dir, createEntry('store-front/main', '2026-09-24T11:00:00Z', 'c', 'three'));
		expect(
			readHistory(dir, { ref: null, query: null, limit: 2 }).map((entry) => entry.did),
		).toEqual(['two', 'three']);
	});

	it('filters by ref and by every query word in asked or did', () => {
		const dir = createDir();
		appendJournalEntry(
			dir,
			createEntry(
				'checkout-api/main',
				'2026-09-24T10:00:00Z',
				'add retry backoff',
				'Backoff added; tests pass.',
			),
		);
		appendJournalEntry(
			dir,
			createEntry('checkout-api/main', '2026-09-24T11:00:00Z', 'fix lint', 'Lint clean.'),
		);
		appendJournalEntry(
			dir,
			createEntry(
				'store-front/main',
				'2026-09-24T12:00:00Z',
				'retry the upload',
				'Upload retried.',
			),
		);
		expect(
			readHistory(dir, { ref: 'checkout-api/main', query: 'retry', limit: 10 }).map(
				(entry) => entry.did,
			),
		).toEqual(['Backoff added; tests pass.']);
		expect(readHistory(dir, { ref: null, query: 'retry tests', limit: 10 })).toHaveLength(1);
	});

	it('a torn last line (crash mid-write) is skipped', () => {
		const dir = createDir();
		appendJournalEntry(dir, createEntry('store-front/main', '2026-09-24T10:00:00Z', 'a', 'kept'));
		appendFileSync(resolveJournalFile(dir, 'store-front/main'), '{"ts":"2026-09-24T11:0');
		expect(
			readHistory(dir, { ref: null, query: null, limit: 10 }).map((entry) => entry.did),
		).toEqual(['kept']);
	});

	it('missing directory or session → empty', () => {
		expect(readHistory(join(createDir(), 'nope'), { ref: null, query: null, limit: 5 })).toEqual(
			[],
		);
		expect(readHistory(createDir(), { ref: 'x/y', query: null, limit: 5 })).toEqual([]);
	});

	it('describeTurnOutcome: the spoken line, else the first sentence clipped', () => {
		expect(describeTurnOutcome('store front, main: tests pass.', 'long text')).toBe(
			'store front, main: tests pass.',
		);
		expect(describeTurnOutcome('', 'Fixed the flake. Then more detail.')).toBe('Fixed the flake.');
		expect(describeTurnOutcome('', 'x'.repeat(300)).length).toBe(200);
	});
});

describe('topics', () => {
	it('state → saved map → loaded back; pinned kept', () => {
		const file = join(createDir(), 'topics.json');
		const session = {
			...createSession({
				ref: 'store-front/main',
				label: 'store-front/main',
				branch: '',
				cwd: '/w',
				dirs: [],
				isPinned: false,
			}),
			topic: 'Locale cleanup',
			isTopicPinned: true,
		};
		saveTopics(
			file,
			collectTopics({ ...createInitialState(), sessions: { 'store-front/main': session } }),
		);
		expect(loadTopics(file)).toEqual({
			'store-front/main': { topic: 'Locale cleanup', pinned: true },
		});
	});

	it('missing or corrupt file → empty', () => {
		expect(loadTopics(join(createDir(), 'none.json'))).toEqual({});
	});
});

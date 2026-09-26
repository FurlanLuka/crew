import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtureState } from '../../test/support/state.js';
import { createDebugNote, saveDebugNote } from './debug-notes.js';

describe('createDebugNote', () => {
	const now = Date.parse('2026-09-25T13:15:00Z');
	const state = createFixtureState(
		{
			view: 'store-front/wrk1',
			needs: 'store-front/wrk1',
			ask: 'permission',
			work: [{ ref: 'voiceos', request: 'Set up wrk3.', minutesAgo: 4 }],
			voiceLog: [
				{ utterance: 'Yes, please.', did: [], reply: 'Should I start reviewing?', minutesAgo: 1 },
			],
			alert: { text: 'store front, work one asks: start reviewing?', secondsAgo: 30 },
		},
		now,
	);

	it("the developer's words and what the screen showed at that moment", () =>
		expect(createDebugNote(state, 'it asked me the same question again', now)).toMatchObject({
			at: '2026-09-25T13:15:00.000Z',
			text: 'it asked me the same question again',
			view: 'store-front/wrk1',
			heardHere: [
				{
					utterance: 'Yes, please.',
					did: [],
					reply: 'Should I start reviewing?',
					at: '2026-09-25T13:14:00.000Z',
				},
			],
			asks: [{ ref: 'store-front/wrk1', kind: 'permission' }],
			spoken: [
				{
					source: 'alert',
					text: 'store front, work one asks: start reviewing?',
					at: '2026-09-25T13:14:30.000Z',
				},
			],
			devOffer: null,
		}));

	it('every session with its status, what it waits on and what it was last asked', () => {
		const sessions = createDebugNote(state, 'x', now).sessions;
		expect(sessions.find((session) => session.ref === 'voiceos')).toEqual({
			ref: 'voiceos',
			status: 'running',
			queued: 0,
			needsUser: null,
			lastAsked: 'Set up wrk3.',
		});
		expect(sessions.find((session) => session.ref === 'store-front/wrk1')?.needsUser).toContain(
			'asks',
		);
	});

	it("on Mission Control → the grid's log", () =>
		expect(createDebugNote(createFixtureState({}, now), 'x', now).view).toBe('grid'));

	it('saved one JSON line per note', () => {
		const file = join(mkdtempSync(join(tmpdir(), 'notes-')), 'logs', 'debug-notes.jsonl');
		saveDebugNote(file, createDebugNote(state, 'first', now));
		saveDebugNote(file, createDebugNote(state, 'second', now));
		expect(
			readFileSync(file, 'utf8')
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line).text),
		).toEqual(['first', 'second']);
	});
});

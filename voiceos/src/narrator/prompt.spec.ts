import { describe, expect, it } from 'bun:test';
import {
	composeNarration,
	createFallbackNarration,
	buildNarratorMessage,
	NARRATOR_SYSTEM,
	type NarratorOutput,
} from './prompt.js';
import {
	cleanSpokenText,
	toSpokenName,
	prefixSessionName,
	stripSessionName,
} from '../shared/spoken.js';

const input = { label: 'store-front/main', asked: 'run the tests', focused: false, topic: null };

describe('composeNarration', () => {
	const output = (patch: Partial<NarratorOutput>): NarratorOutput => ({
		speak: true,
		needs_user: false,
		priority: 'normal',
		text: 'The api dev server is on port 51049; crew allocated it instead of 3000.',
		topic: null,
		about: null,
		answer: null,
		choosing: null,
		...patch,
	});

	it('a direct answer → spoken alone, whatever text added around it', () =>
		expect(composeNarration(output({ answer: 'Port 51049.' })).text).toBe('Port 51049.'));

	it('a choice → what is chosen and the options prompt, never the options', () =>
		expect(
			composeNarration(
				output({
					needs_user: true,
					text: 'asks: cache rates in Redis, precompute nightly, or an LRU?',
					choosing: 'How should rates be cached?',
				}),
			),
		).toMatchObject({
			needs_user: true,
			text: 'asks: How should rates be cached? Say options to hear them.',
		}));

	it('neither → text as written, cleaned for the ear; the extra fields never reach the state', () => {
		const narration = composeNarration(output({ text: 'Fixed the `retry` loop.' }));

		expect(narration.text).toBe('Fixed the loop.');
		expect(Object.keys(narration).sort()).toEqual(
			// about goes on to the turn narrator, for announcing a question from another screen.
			['about', 'needs_user', 'priority', 'speak', 'text', 'topic'].sort(),
		);
	});

	it('a blank answer or choice → text is kept', () =>
		expect(composeNarration(output({ answer: '  ', choosing: '' })).text).toBe(
			'The api dev server is on port 51049; crew allocated it instead of 3000.',
		));
});

describe('cleanSpokenText', () => {
	it('drops inline code, file paths and URLs; keeps worktree names', () =>
		expect(
			cleanSpokenText(
				'store-front/main edited `retry.ts` in src/payments/retry.ts, see https://x.dev/a — done',
			),
		).toBe('store-front/main edited in see — done'));
	it('drops a single file with an extension', () =>
		expect(cleanSpokenText('Updated README.md and pushed')).toBe('Updated README.md and pushed'));
	it('strips markdown emphasis', () =>
		expect(cleanSpokenText('**Tests pass.** _All_ green')).toBe('Tests pass. All green'));
	it('60 words without a sentence end, cap 10 → the first 10, "…", "More on screen."', () =>
		expect(cleanSpokenText('word '.repeat(60), 10)).toBe(
			`${'word '.repeat(10).trim()}… More on screen.`,
		));
	it('never more than 70 words by default: a TL;DR, never the whole reply', () =>
		expect(cleanSpokenText('word '.repeat(100))).toBe(
			`${'word '.repeat(70).trim()}… More on screen.`,
		));
});

describe('buildNarratorMessage', () => {
	it('long text keeps the start and the closing question', () => {
		const text = `Start. ${'x'.repeat(9000)} Want me to push?`;
		const message = buildNarratorMessage({ ...input, text });
		expect(message).toContain('Start.');
		expect(message).toContain('Want me to push?');
		expect(message.length).toBeLessThan(6500);
	});
	it('marks focus and what was asked', () => {
		expect(buildNarratorMessage({ ...input, focused: true, text: 'Done.' })).toContain(
			'focused: yes',
		);
		expect(buildNarratorMessage({ ...input, text: 'Done.' })).toContain(
			'developer asked: run the tests',
		);
	});
	it('a promised report → said so, in its own line', () => {
		expect(buildNarratorMessage({ ...input, text: 'Clean.', isReportPromised: true })).toBe(
			[
				'session: store-front/main',
				'focused: no',
				'current topic: none',
				'developer asked: run the tests',
				'voice os promised a report',
				'',
				'session wrote:',
				'Clean.',
			].join('\n'),
		);
		expect(buildNarratorMessage({ ...input, text: 'Clean.' })).not.toContain('promised');
	});
});

describe('createFallbackNarration', () => {
	it('closing question → spoken, needs the user, with the question', () => {
		expect(
			createFallbackNarration({ ...input, text: 'All tests pass. Want me to push the branch?' }),
		).toEqual({
			speak: true,
			needs_user: true,
			priority: 'high',
			text: 'asks: Want me to push the branch?',
			topic: null,
		});
	});
	it('plain report → silent', () =>
		expect(createFallbackNarration({ ...input, text: 'All tests pass.' })).toMatchObject({
			speak: false,
			needs_user: false,
		}));
});

describe('toSpokenName', () => {
	it('ref → how it is said', () => {
		expect(toSpokenName('store-front/wrk1')).toBe('store front, work 1');
		expect(toSpokenName('checkout-api/main')).toBe('checkout api, main');
		expect(toSpokenName('voiceos')).toBe('voiceos');
	});
	it('prefixSessionName prefixes, and an empty body stays empty', () => {
		expect(prefixSessionName('store-front/main', 'tests pass.')).toBe(
			'store front, main: tests pass.',
		);
		expect(prefixSessionName('store-front/main', '  ')).toBe('');
		expect(prefixSessionName('store-front/main', 'Asks: push it?')).toBe(
			'store front, main asks: push it?',
		);
	});
});

describe('stripSessionName', () => {
	it('the session on screen → no name, an "asks" line becomes the question itself', () => {
		expect(stripSessionName('asks: push the branch now?')).toBe('Push the branch now?');
		expect(stripSessionName('tests pass.')).toBe('Tests pass.');
		expect(stripSessionName('  ')).toBe('');
	});
});

describe('NARRATOR_SYSTEM', () => {
	it('every line works heard alone: no shorter cap on screen, no bare verdict, caveats kept', () => {
		expect(NARRATOR_SYSTEM).not.toContain('at most 20 words: they can read the rest');
		expect(NARRATOR_SYSTEM).toContain('Never speak a bare verdict as the whole line');
		expect(NARRATOR_SYSTEM).toContain('is always spoken, ahead of other detail');
	});
});

import { describe, expect, it } from 'bun:test';
import { cleanSpokenText, createFallbackNarration, buildNarratorMessage } from './prompt.js';
import { toSpokenName, prefixSessionName, stripSessionName } from '../shared/spoken.js';

const input = { label: 'store-front/main', asked: 'run the tests', focused: false, topic: null };

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
	it('caps the length', () =>
		expect(cleanSpokenText('word '.repeat(60), 10).split(' ')).toHaveLength(10));
	it('never more than 25 words by default: narration is unsolicited', () =>
		expect(cleanSpokenText('word '.repeat(60)).split(' ')).toHaveLength(25));
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

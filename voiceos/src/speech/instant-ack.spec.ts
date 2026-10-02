import { describe, expect, it } from 'bun:test';
import { findWakePhrase } from './wake.js';
import {
	INTERRUPT_PATTERN,
	normalizeUtterance,
	STANDALONE_WORDS,
	stripTags,
} from '../shared/spoken.js';
import {
	decideInstantAck,
	INSTANT_ACK_POOL,
	type InstantAckMoment,
	pickInstantAck,
	rememberInstantAck,
	SPOKE_RECENTLY_MS,
} from './instant-ack.js';

describe('the instant ack pool', () => {
	it('seven neutral lines, none of them a wake word, a stop word, or a question', () => {
		expect(INSTANT_ACK_POOL.map((line) => stripTags(line.text))).toEqual([
			'Mm-hm.',
			'Okay.',
			'Got it.',
			'One sec.',
			'Sure.',
			'On it.',
			'Let me check.',
		]);

		for (const line of INSTANT_ACK_POOL) {
			const text = stripTags(line.text);
			const words = normalizeUtterance(text);

			expect(findWakePhrase(text)).toBeNull();
			expect(INTERRUPT_PATTERN.test(words)).toBe(false);
			expect(STANDALONE_WORDS.has(words)).toBe(false);
			expect(text.endsWith('?')).toBe(false);
		}
	});

	it('every line is voiced warm: [warm] kept its words whole in a TTS → STT round trip', () => {
		expect(
			INSTANT_ACK_POOL.every((line) => line.keepsTags && line.text.startsWith('[warm] ')),
		).toBe(true);
	});
});

describe('pickInstantAck', () => {
	it('never either of the last two lines used', () => {
		let history: string[] = [];

		for (let round = 0; round < 200; round++) {
			const line = pickInstantAck({ history, isQuestion: false });

			expect(history).not.toContain(line.text);
			history = rememberInstantAck(history, line.text);
		}
	});

	it('random over the rest: the lowest and highest draw land on the first and last left', () => {
		const history = ['[warm] Mm-hm.', '[warm] Okay.'];

		expect(pickInstantAck({ history, isQuestion: false, random: () => 0 }).text).toBe(
			'[warm] Got it.',
		);
		expect(pickInstantAck({ history, isQuestion: false, random: () => 0.999 }).text).toBe(
			'[warm] Let me check.',
		);
	});

	it('after a question, only a line that cannot be heard as the answer', () => {
		const picked = new Set<string>();
		let history: string[] = [];

		for (let round = 0; round < 50; round++) {
			const line = pickInstantAck({ history, isQuestion: true });
			picked.add(stripTags(line.text));
			history = rememberInstantAck(history, line.text);
		}

		expect([...picked].sort()).toEqual(['Let me check.', 'One sec.']);
	});

	it('remembers the last two only', () =>
		expect(rememberInstantAck(['Mm-hm.', 'Okay.'], 'Sure.')).toEqual(['Okay.', 'Sure.']));
});

describe('decideInstantAck', () => {
	const moment = (patch: Partial<InstantAckMoment> = {}): InstantAckMoment => ({
		isMuted: false,
		words: 6,
		minWords: 4,
		msSinceSpoke: null,
		hasReplySinceTurn: false,
		isPlayingOrQueued: false,
		isTalking: false,
		...patch,
	});

	it('a request in the quiet → said', () =>
		expect(decideInstantAck(moment())).toEqual({ kind: 'say' }));

	it.each<[string, Partial<InstantAckMoment>, string]>([
		['muted', { isMuted: true }, 'muted'],
		['under four words (a yes, a name, its own echo)', { words: 3 }, 'short'],
		['the developer talks again', { isTalking: true }, 'talking'],
		['an answer was queued in the turn', { hasReplySinceTurn: true }, 'answered'],
		['something plays or waits', { isPlayingOrQueued: true }, 'busy'],
		['Voice OS spoke a moment ago', { msSinceSpoke: SPOKE_RECENTLY_MS - 1 }, 'spoke recently'],
	])('%s → skipped', (_, patch, reason) =>
		expect(decideInstantAck(moment(patch))).toEqual({ kind: 'skip', reason }),
	);

	it('Voice OS spoke a while ago → said', () =>
		expect(decideInstantAck(moment({ msSinceSpoke: SPOKE_RECENTLY_MS }))).toEqual({
			kind: 'say',
		}));
});

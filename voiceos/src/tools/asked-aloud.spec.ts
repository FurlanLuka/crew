import { describe, expect, it } from 'bun:test';
import type { SpokenLine } from '../shared/protocol.js';
import {
	ASKED_ALOUD_MS,
	findLastAskedAloud,
	findVoiceOsQuestion,
	formatHeardBefore,
	listHeardBefore,
} from './asked-aloud.js';

const line = (id: string, at: number, patch: Partial<SpokenLine> = {}): SpokenLine => ({
	id,
	text: id,
	source: 'narrator',
	at,
	ref: 'store/main',
	...patch,
});

describe('findLastAskedAloud', () => {
	it('a question that started after the developer began speaking was not heard: not asked aloud', () => {
		const spoken = [
			line('earlier', 1000, { isAsking: true }),
			line('while-talking', 5000, { isAsking: true }),
		];

		expect(
			findLastAskedAloud({ spoken, waitingRefs: ['store/main'], now: 6000, heardFrom: 4000 })?.id,
		).toBe('earlier');
		expect(findLastAskedAloud({ spoken, waitingRefs: ['store/main'], now: 6000 })?.id).toBe(
			'while-talking',
		);
	});
});

describe('findLastAskedAloud and the meanwhile line', () => {
	const meanwhile = (toldRefs: string[]) =>
		line('meanwhile', 1000, {
			ref: undefined,
			isAsking: true,
			isUpdate: true,
			refs: toldRefs,
			toldAsks: toldRefs.map((ref, index) => ({ ref, askId: `a${index}` })),
		});

	it('it asked for one session → that session is the one a bare yes answers', () =>
		expect(
			findLastAskedAloud({
				spoken: [meanwhile(['checkout/main'])],
				waitingRefs: ['checkout/main'],
				now: 2000,
			})?.ref,
		).toBe('checkout/main'));

	it('it asked for two still waiting → the line, but about neither', () => {
		const found = findLastAskedAloud({
			spoken: [meanwhile(['checkout/main', 'signals/main'])],
			waitingRefs: ['checkout/main', 'signals/main'],
			now: 2000,
		});

		expect(found?.id).toBe('meanwhile');
		expect(found?.ref).toBeUndefined();
	});

	it('one of the two already answered → the one still waiting', () =>
		expect(
			findLastAskedAloud({
				spoken: [meanwhile(['checkout/main', 'signals/main'])],
				waitingRefs: ['signals/main'],
				now: 2000,
			})?.ref,
		).toBe('signals/main'));
});

describe('heard before the developer spoke', () => {
	it('session lines that started before, within 90 s, the newest three, oldest first', () => {
		const spoken = [
			line('too-old', 0),
			line('a', 20_000),
			line('no-session', 30_000, { ref: undefined }),
			line('ack', 45_000, { source: 'kernel' }),
			line('b', 40_000),
			line('c', 50_000),
			line('d', 60_000),
			line('after', 100_000),
		];

		expect(listHeardBefore({ spoken, heardFrom: 95_000 }).map((heard) => heard.id)).toEqual([
			'b',
			'c',
			'd',
		]);
	});

	it('says how each ended: played out, cut off, or still playing', () =>
		expect(
			formatHeardBefore(
				[
					line('It is doable without a rewrite.', 1000, { ref: 'checkout/main', endedAt: 4000 }),
					line('Plan approved.', 5000, { endedAt: 6000, isCut: true }),
					line('Building now.', 7000),
				],
				10_000,
			),
		).toBe(
			'checkout/main: "It is doable without a rewrite." (ended 6s before they spoke); store/main: "Plan approved." (cut off after 1s, 4s before they spoke); store/main: "Building now." (still playing when they spoke)',
		));

	it('nothing heard → (nothing)', () => expect(formatHeardBefore([], 0)).toBe('(nothing)'));
});

describe('findVoiceOsQuestion', () => {
	const asked = line('asked', 1000, {
		source: 'kernel',
		text: 'Did you mean the notes?',
		ref: undefined,
	});
	const find = (spoken: SpokenLine[], now = 5000, heardFrom = 4000) =>
		findVoiceOsQuestion({ spoken, now, heardFrom })?.id ?? null;

	it('Voice OS asked last → that question', () => {
		expect(find([line('earlier', 500), asked])).toBe('asked');
	});

	it('a session spoke after it → none: the words follow the session', () => {
		expect(find([asked, line('session', 2000)])).toBeNull();
	});

	it('a statement of Voice OS → none', () => {
		expect(find([{ ...asked, text: 'Debug note saved.' }])).toBeNull();
	});

	it('older than the window → none', () => {
		expect(find([asked], 1000 + ASKED_ALOUD_MS + 1, 1000 + ASKED_ALOUD_MS)).toBeNull();
	});

	it('started after the developer began speaking → not heard, none', () => {
		expect(find([asked], 5000, 900)).toBeNull();
	});

	it('filler after it ("Okay.") → still that question; filler alone asks nothing', () => {
		const ack = line('ack', 2000, {
			source: 'kernel',
			text: 'Okay?',
			ref: undefined,
			isFiller: true,
		});

		expect(find([asked, ack])).toBe('asked');
		expect(find([ack])).toBeNull();
	});

	it('filler is never what the developer heard before they spoke', () => {
		const ack = line('ack', 3000, { source: 'kernel', text: 'Got it.', isFiller: true });

		expect(listHeardBefore({ spoken: [line('session', 2000), ack], heardFrom: 4000 })).toEqual([
			line('session', 2000),
		]);
	});

	it('an update relaying sessions → theirs, none', () => {
		expect(find([{ ...asked, isUpdate: true }])).toBeNull();
	});

	it("a line relaying sessions' asks → theirs, none", () => {
		expect(find([{ ...asked, toldAsks: [{ ref: 'store/main', askId: 'a1' }] }])).toBeNull();
	});

	it('a line nobody heard after it does not hide it', () => {
		expect(find([asked, line('unplayed', 2000, { isUnplayed: true })])).toBe('asked');
	});
});

describe('formatHeardBefore and the screen session', () => {
	it("the screen session's line is cut at 600 characters, another's at 140", () => {
		const long = 'x'.repeat(700);
		const heard = [
			line('screen', 1000, { text: long, ref: 'store/main', endedAt: 2000 }),
			line('other', 1000, { text: long, ref: 'other/main', endedAt: 2000 }),
		];

		expect(formatHeardBefore(heard, 3000, 'store/main')).toBe(
			`store/main: "${'x'.repeat(600)}…" (ended 1s before they spoke); other/main: "${'x'.repeat(140)}…" (ended 1s before they spoke)`,
		);
	});
});

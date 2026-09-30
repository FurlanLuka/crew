import { describe, expect, it } from 'bun:test';
import type { SpokenLine } from '../shared/protocol.js';
import { findLastAskedAloud, formatHeardBefore, listHeardBefore } from './asked-aloud.js';

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

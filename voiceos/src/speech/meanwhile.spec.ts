import { describe, expect, it } from 'bun:test';
import type { MeanwhileItem } from '../shared/protocol.js';
import { decideMeanwhile, describeMeanwhile } from './meanwhile.js';

const item = (ref: string, kind: MeanwhileItem['kind'], about: string | null = null, at = 0) => ({
	ref,
	kind,
	about,
	at,
});
const nameOf = (ref: string) => ref.split('/')[0] ?? ref;

describe('describeMeanwhile', () => {
	it.each([
		[
			[item('checkout/main', 'done', 'all retry tests pass.')],
			'Meanwhile, checkout said: all retry tests pass.',
		],
		[
			[
				item('checkout/main', 'done', 'all retry tests pass'),
				item('ranking/main', 'needs', 'the index'),
			],
			'Meanwhile, ranking needs you about the index, and checkout said: all retry tests pass.',
		],
		[
			[
				item('checkout/main', 'done', 'all retry tests pass'),
				item('ranking/main', 'needs', 'the index'),
				item('signals/main', 'done'),
				item('admin/main', 'done'),
			],
			'Meanwhile, ranking needs you about the index, checkout said: all retry tests pass, and two others finished.',
		],
		[
			[item('a/main', 'done'), item('b/main', 'done'), item('c/main', 'needs')],
			'Meanwhile, c needs you, a finished, and one other finished.',
		],
		[
			[
				item('a/main', 'done'),
				item('b/main', 'done'),
				item('c/main', 'done'),
				item('d/main', 'needs'),
			],
			'Meanwhile, d needs you, a finished, and two others finished.',
		],
	])('%#', (items, said) => expect(describeMeanwhile({ items, nameOf })).toBe(said));
});

describe('decideMeanwhile', () => {
	const items = [item('checkout/main', 'done', null, 1000)];

	it('nothing waiting → nothing', () =>
		expect(decideMeanwhile({ items: [], now: 5000, quietSince: 0, isListening: false })).toEqual({
			kind: 'none',
		}));

	it('push to talk: after 8 s of quiet; listening: after 12 s', () => {
		expect(decideMeanwhile({ items, now: 9000, quietSince: 1000, isListening: false })).toEqual({
			kind: 'now',
		});
		expect(decideMeanwhile({ items, now: 9000, quietSince: 1000, isListening: true })).toEqual({
			kind: 'wait',
			ms: 4000,
		});
	});

	it('waited 50 s → this gap, however short', () =>
		expect(decideMeanwhile({ items, now: 51_000, quietSince: 50_500, isListening: false })).toEqual(
			{
				kind: 'now',
			},
		));
});

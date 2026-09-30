import { describe, expect, it } from 'bun:test';
import { createFixtureState } from '../../test/support/state.js';
import { describeExchangeLines } from './exchange-lines.js';

const NOW = 1_000_000;
const describeFor = (state: ReturnType<typeof createFixtureState>) =>
	describeExchangeLines({ state, now: NOW, nameRef: (ref) => ref });

describe('describeExchangeLines', () => {
	it('no conversation off screen → nothing: an ordinary turn reads what it always did', () =>
		expect(describeFor(createFixtureState({ view: 'store-front/main' }, NOW))).toEqual([]));

	it('talking with a session off screen → what was asked and answered, and where follow-ups go', () => {
		const lines = describeFor(
			createFixtureState(
				{
					view: 'store-front/main',
					talkingWith: {
						ref: 'checkout-api/main',
						asked: 'is the build green?',
						answered: 'Yes, all 214 tests pass.',
						secondsAgo: 10,
					},
				},
				NOW,
			),
		);

		expect(lines[0]).toBe(
			'Talking with checkout-api/main (not on screen, since 30s ago): the developer last asked it "is the build green?"; it answered "Yes, all 214 tests pass.".',
		);
		expect(lines[1]).toContain('are for checkout-api/main — send_to it, not forward');
	});

	it('the conversation lapsed a minute ago → nothing', () =>
		expect(
			describeFor(
				createFixtureState(
					{
						view: 'store-front/main',
						talkingWith: { ref: 'checkout-api/main', asked: 'x', answered: 'y', secondsAgo: 61 },
					},
					NOW,
				),
			),
		).toEqual([]));
});

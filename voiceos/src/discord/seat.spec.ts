import { describe, expect, it } from 'bun:test';
import { DISCORD_CLIENT } from './bridge.js';
import { decidePageMic, SpeakerSeat } from './seat.js';

const seatWith = (page: string | null): SpeakerSeat => {
	const seat = new SpeakerSeat();

	if (page) {
		seat.pageOpened(page);
	}

	return seat;
};

describe('SpeakerSeat', () => {
	it('the owner joins while a page speaks → the channel speaks, announced once; leaving → that page again', () => {
		const seat = seatWith('tab-a');

		expect(seat.discordJoined()).toBe(true);
		expect(seat.current).toBe(DISCORD_CLIENT);
		// A mode change calls the join again.
		expect(seat.discordJoined()).toBe(false);

		seat.discordLeft();

		expect(seat.current).toBe('tab-a');
	});

	it('a page used while in the channel → the channel keeps the seat', () => {
		const seat = seatWith('tab-a');

		seat.discordJoined();
		seat.pageUsed('tab-b');

		expect(seat.current).toBe(DISCORD_CLIENT);
	});

	it('the page from before closed meanwhile → leaving gives no speaker, never a closed tab', () => {
		const seat = seatWith('tab-a');

		seat.discordJoined();
		seat.pageClosed('tab-a');
		seat.discordLeft();

		expect(seat.current).toBeNull();
	});

	it('no page when joining → no speaker after leaving; the next page used takes it', () => {
		const seat = seatWith(null);

		seat.discordJoined();
		seat.discordLeft();
		expect(seat.current).toBeNull();

		seat.pageUsed('tab-b');
		expect(seat.current).toBe('tab-b');
	});

	it('a second page opening → the first keeps the audio', () => {
		const seat = seatWith('tab-a');

		seat.pageOpened('tab-b');

		expect(seat.current).toBe('tab-a');
	});
});

describe('decidePageMic', () => {
	it('voice off → a press and a listen both dropped, never refused (the tab keeps its mode)', () => {
		expect(decidePageMic('ptt_start', false, true)).toBe('ignore');
		expect(decidePageMic('listen_start', false, true)).toBe('ignore');
		expect(decidePageMic('listen_start', true, true)).toBe('ignore');
	});

	it('not in the channel → the page mic works', () => {
		expect(decidePageMic('ptt_start', false, false)).toBe('allow');
		expect(decidePageMic('listen_start', false, false)).toBe('allow');
	});

	// The refusal is a listen_off, so the page drops to push to talk and stays there after leaving.
	it('in the channel → a press ignored, listening refused', () => {
		expect(decidePageMic('ptt_start', true, false)).toBe('ignore');
		expect(decidePageMic('listen_start', true, false)).toBe('refuse');
	});
});

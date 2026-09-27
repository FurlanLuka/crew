import { describe, expect, it } from 'bun:test';
import {
	clearQueueForTalk,
	createEmptyQueue,
	dropQueued,
	enqueue,
	shouldChime,
	REPLY_FRESH_MS,
	setMuted,
	takeNextItem,
	type SpeechItem,
} from './queue.js';

const createItem = (
	id: string,
	priority: SpeechItem['priority'],
	ref: string | null = null,
	at = 0,
): SpeechItem => ({ id, text: id, priority, ref, at, source: 'narrator' });
const fillQueue = (...items: SpeechItem[]) =>
	items.reduce((queue, queued) => enqueue(queue, queued).queue, createEmptyQueue());

describe('enqueue', () => {
	it('alert → first in line and interrupts playback', () => {
		const result = enqueue(
			fillQueue(createItem('a', 'normal'), createItem('b', 'low')),
			createItem('c', 'alert'),
		);
		expect(result.shouldInterrupt).toBe(true);
		expect(result.queue.items.map((queued) => queued.id)).toEqual(['c', 'a', 'b']);
	});

	it('newer line about a session replaces its older unspoken one', () => {
		const queue = fillQueue(
			createItem('old', 'normal', 'store/main', 1),
			createItem('other', 'normal', 'checkout/main', 2),
			createItem('new', 'normal', 'store/main', 3),
		);
		expect(queue.items.map((queued) => queued.id)).toEqual(['other', 'new']);
	});

	it('a promised report waits its turn: the next ack about the session never replaces it', () => {
		const queue = fillQueue(
			{ ...createItem('report', 'high', 'store/main', 1), isOwed: true },
			createItem('ack', 'high', 'store/main', 2),
		);
		expect(queue.items.map((queued) => queued.id)).toEqual(['report', 'ack']);
	});

	it('an ack replaces nothing still waiting about its session', () => {
		const queue = fillQueue(createItem('result', 'normal', 'store/main', 1), {
			...createItem('ack', 'high', 'store/main', 2),
			isAck: true,
		});
		expect(queue.items.map((queued) => queued.id)).toEqual(['ack', 'result']);
	});

	it('a promised report survives talk and quiet, like any high line', () => {
		const queue = fillQueue({ ...createItem('report', 'high', 'store/main'), isOwed: true });
		expect(clearQueueForTalk(queue).items.map((queued) => queued.id)).toEqual(['report']);
		expect(setMuted(queue, true).items.map((queued) => queued.id)).toEqual(['report']);
	});

	it('a low line never replaces a waiting high one for the same session', () => {
		const queue = fillQueue(
			createItem('question', 'high', 'store/main'),
			createItem('progress', 'low', 'store/main'),
		);
		expect(queue.items.map((queued) => queued.id)).toEqual(['question', 'progress']);
	});

	it('muted → normal and low dropped, questions and alerts still spoken', () => {
		const muted = setMuted(createEmptyQueue(), true);
		expect(enqueue(muted, createItem('n', 'normal')).isDropped).toBe(true);
		expect(enqueue(muted, createItem('h', 'high')).isDropped).toBe(false);
		expect(enqueue(muted, createItem('a', 'alert')).isDropped).toBe(false);
	});
});

describe('takeNextItem', () => {
	it('stale progress (>5 s) and stale completions (>2 min) are skipped', () => {
		const queue = fillQueue(
			createItem('progress', 'low', null, 0),
			createItem('done', 'normal', null, 0),
			createItem('ask', 'high', null, 0),
		);
		const first = takeNextItem(queue, 10_000);
		expect(first.item?.id).toBe('ask');
		expect(takeNextItem(first.queue, 10_000).item?.id).toBe('done');
		expect(takeNextItem(takeNextItem(first.queue, 200_000).queue, 200_000).item).toBeNull();
	});

	it('empty → null', () => expect(takeNextItem(createEmptyQueue(), 0).item).toBeNull());
});

describe('clearQueueForTalk', () => {
	it('keeps questions and alerts, drops chatter', () => {
		const queue = clearQueueForTalk(
			fillQueue(
				createItem('a', 'alert'),
				createItem('h', 'high'),
				createItem('n', 'normal'),
				createItem('l', 'low'),
			),
		);
		expect(queue.items.map((queued) => queued.id)).toEqual(['a', 'h']);
	});
});

describe('shouldChime', () => {
	const createChimeItem = (isReply: boolean, at = 0) => ({
		id: 'a',
		text: 'x',
		priority: 'high' as const,
		ref: null,
		at,
		source: 'kernel' as const,
		isReply,
	});
	it('a reply played at once → no chime', () =>
		expect(shouldChime(createChimeItem(true, 1000), 1000 + REPLY_FRESH_MS)).toBe(false));
	it('a reply that waited behind other speech → chime', () =>
		expect(shouldChime(createChimeItem(true, 1000), 1001 + REPLY_FRESH_MS)).toBe(true));
	it('an announcement → chime', () =>
		expect(shouldChime(createChimeItem(false, 1000), 1000)).toBe(true));
});

describe('dropQueued', () => {
	it("that session's lines from before the words go, owed ones too; others and newer stay", () => {
		const queue = createEmptyQueue();
		const items = [
			{ ...createItem('old', 'high', 'store/main', 100), isOwed: true },
			createItem('other', 'normal', 'checkout/main', 100),
			createItem('newer', 'normal', 'store/main', 500),
			createItem('none', 'normal', null, 100),
		];
		const filled = { ...queue, items };

		expect(
			dropQueued(filled, { ref: 'store/main', before: 300 }).items.map((item) => item.id),
		).toEqual(['other', 'newer', 'none']);
		expect(filled.items).toHaveLength(4);
	});
});

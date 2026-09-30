import type { SpokenLine } from '../shared/protocol.js';

export type SpeechPriority = 'alert' | 'high' | 'normal' | 'low';

export interface SpeechItem {
	id: string;
	text: string;
	priority: SpeechPriority;
	ref: string | null;
	at: number;
	source: SpokenLine['source'];
	// Said with the session's name unless that session is on screen when the line plays.
	isNamed?: boolean;
	// The answer to what the developer just said.
	isReply?: boolean;
	// A session's own answer to the developer: heard to the end, it keeps their conversation going.
	isAnswer?: boolean;
	isAsking?: boolean;
	// A line the developer is waiting for (a report, the session's own line): never replaced.
	isOwed?: boolean;
	// Voice OS saying it passed words on: it replaces nothing still waiting to be said.
	isAck?: boolean;
	// A session's own line queued while it was on screen: held instead if the developer has gone
	// elsewhere by the time it plays.
	isHoldable?: boolean;
	chime?: 'needs';
}

export interface SpeechQueue {
	items: SpeechItem[];
	isMuted: boolean;
}

export interface Enqueued {
	queue: SpeechQueue;
	shouldInterrupt: boolean;
	isDropped: boolean;
}

interface TakenItem {
	item: SpeechItem | null;
	queue: SpeechQueue;
}

const PRIORITY_RANK: Record<SpeechPriority, number> = { alert: 0, high: 1, normal: 2, low: 3 };
export const LOW_TTL_MS = 5_000;
export const NORMAL_TTL_MS = 120_000;
export const REPLY_FRESH_MS = 3_000;

export const shouldChime = (item: SpeechItem, now: number): boolean => {
	// Only a fresh reply lands as the answer; anything else would come out of nowhere.
	return !(item.isReply && now - item.at <= REPLY_FRESH_MS);
};

export const createEmptyQueue = (): SpeechQueue => ({ items: [], isMuted: false });

export const enqueue = (queue: SpeechQueue, item: SpeechItem): Enqueued => {
	// "quiet" silences everything but alerts and questions.
	if (queue.isMuted && PRIORITY_RANK[item.priority] > PRIORITY_RANK.high) {
		return { queue, shouldInterrupt: false, isDropped: true };
	}

	// A newer line about a session replaces its older unspoken ones.
	const kept = queue.items.filter(
		(existing) =>
			item.isAck ||
			existing.isOwed ||
			!(
				item.ref &&
				existing.ref === item.ref &&
				PRIORITY_RANK[existing.priority] >= PRIORITY_RANK[item.priority]
			),
	);
	const items = [...kept, item].sort(
		(first, second) =>
			PRIORITY_RANK[first.priority] - PRIORITY_RANK[second.priority] || first.at - second.at,
	);

	// Alerts (permissions, questions) cut off whatever is playing.
	return {
		queue: { ...queue, items },
		shouldInterrupt: item.priority === 'alert',
		isDropped: false,
	};
};

interface TakeNextItemParams {
	now: number;
	// The session the developer is talking with: its lines, and Voice OS's word that they went there,
	// come before older lines from anyone else — never before an alert.
	exchangeRef: string | null;
}

const isExchangeLine = (item: SpeechItem, exchangeRef: string | null): boolean =>
	Boolean(item.isAck) ||
	(item.source === 'kernel' && Boolean(item.isReply)) ||
	(exchangeRef !== null && item.ref === exchangeRef);

const rankFor = (item: SpeechItem, exchangeRef: string | null): number => {
	if (item.priority === 'alert') {
		return 0;
	}

	return isExchangeLine(item, exchangeRef) ? 1 : 1 + PRIORITY_RANK[item.priority];
};

export const takeNextItem = (
	queue: SpeechQueue,
	{ now, exchangeRef }: TakeNextItemParams,
): TakenItem => {
	const fresh = queue.items.filter((queued) => {
		if (queued.priority === 'low') {
			return now - queued.at <= LOW_TTL_MS;
		}

		if (queued.priority === 'normal') {
			return now - queued.at <= NORMAL_TTL_MS;
		}

		return true;
	});
	const ordered = [...fresh].sort(
		(first, second) =>
			rankFor(first, exchangeRef) - rankFor(second, exchangeRef) || first.at - second.at,
	);
	const [item = null] = ordered;

	return { item, queue: { ...queue, items: fresh.filter((queued) => queued !== item) } };
};

interface DropQueuedParams {
	ref: string;
	before: number;
}

export const dropQueued = (queue: SpeechQueue, { ref, before }: DropQueuedParams): SpeechQueue => ({
	...queue,
	// Owed ones too: the developer moved on before hearing them.
	items: queue.items.filter((queued) => queued.ref !== ref || queued.at >= before),
});

export const setMuted = (queue: SpeechQueue, isMuted: boolean): SpeechQueue => ({
	isMuted,
	items: isMuted
		? queue.items.filter((queued) => PRIORITY_RANK[queued.priority] <= PRIORITY_RANK.high)
		: queue.items,
});

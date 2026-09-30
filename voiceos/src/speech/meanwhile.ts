// "Meanwhile, ranking needs you about the index, checkout said: all tests pass, and two others
// finished." Other sessions' updates wait for a quiet moment and arrive as one line, so the
// developer's own conversation is never interrupted by them.
import {
	MEANWHILE_MAX_WAIT_MS,
	MEANWHILE_QUIET_LISTENING_MS,
	MEANWHILE_QUIET_MS,
	type MeanwhileItem,
} from '../shared/protocol.js';
import { NUMBER_WORDS } from '../shared/spoken.js';

const NAMED_AT_MOST = 2;

// A cut line keeps its ellipsis: the pause says it was cut.
const trimAbout = (about: string | null): string | null =>
	about?.trim().replace(/[.!?]+$/, '') || null;

const describeItem = (name: string, item: MeanwhileItem): string => {
	const about = trimAbout(item.about);

	return item.kind === 'needs'
		? `${name} needs you${about ? ` about ${about}` : ''}`
		: about
			? `${name} said: ${about}`
			: `${name} finished`;
};

const countOthers = (rest: MeanwhileItem[]): string => {
	const count = NUMBER_WORDS[rest.length] ?? String(rest.length);
	const isOne = rest.length === 1;
	const verb = rest.every((item) => item.kind === 'done')
		? 'finished'
		: rest.every((item) => item.kind === 'needs')
			? isOne
				? 'needs you'
				: 'need you'
			: isOne
				? 'has an update'
				: 'have updates';

	return `${count} other${isOne ? '' : 's'} ${verb}`;
};

const joinSpoken = (parts: string[]): string =>
	parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;

interface DescribeMeanwhileParams {
	items: MeanwhileItem[];
	nameOf: (ref: string) => string;
}

// What needs the developer comes first, at most two sessions are named, the rest are counted.
export const describeMeanwhile = ({ items, nameOf }: DescribeMeanwhileParams): string => {
	const ordered = [
		...items.filter((item) => item.kind === 'needs'),
		...items.filter((item) => item.kind === 'done'),
	];
	const named = ordered.slice(0, NAMED_AT_MOST);
	const rest = ordered.slice(NAMED_AT_MOST);
	const parts = [
		...named.map((item) => describeItem(nameOf(item.ref), item)),
		...(rest.length > 0 ? [countOthers(rest)] : []),
	];

	const line = `Meanwhile, ${joinSpoken(parts)}`;

	return line.endsWith('…') ? line : `${line}.`;
};

interface DecideMeanwhileParams {
	items: MeanwhileItem[];
	now: number;
	// Since nothing was said or heard either way.
	quietSince: number;
	isListening: boolean;
}

export type MeanwhileTiming = { kind: 'now' } | { kind: 'wait'; ms: number } | { kind: 'none' };

// Called only when nothing plays and the developer is not talking.
export const decideMeanwhile = ({
	items,
	now,
	quietSince,
	isListening,
}: DecideMeanwhileParams): MeanwhileTiming => {
	const oldest = items.reduce((first, item) => Math.min(first, item.at), Number.POSITIVE_INFINITY);

	if (!Number.isFinite(oldest)) {
		return { kind: 'none' };
	}

	const quietNeeded = isListening ? MEANWHILE_QUIET_LISTENING_MS : MEANWHILE_QUIET_MS;
	const quietLeft = quietNeeded - (now - quietSince);
	const waitLeft = MEANWHILE_MAX_WAIT_MS - (now - oldest);

	// Waited long enough: this gap, however short, is the one.
	if (quietLeft <= 0 || waitLeft <= 0) {
		return { kind: 'now' };
	}

	return { kind: 'wait', ms: Math.min(quietLeft, waitLeft) };
};

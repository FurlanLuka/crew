import type { Session } from '../shared/protocol.js';
import { cleanSessionLine, stripTags } from '../shared/spoken.js';
import { readSpokenTag } from '../shared/spoken-tags.js';
import type { Effect } from './reducer.js';

export interface SpokenLines {
	spokenInTurn: string[];
	effects: Effect[];
	// Off screen the line is kept for when the developer switches there, not said.
	held: { kind: 'line'; text: string; isAsking: boolean } | null;
}

export const speakNewTag = (session: Session, text: string, isOnScreen: boolean): SpokenLines => {
	// A message's line is said as soon as its tag closes, from the stream or the finished message, once.
	const tag = readSpokenTag(text);

	if (!tag || session.spokenInTurn.includes(tag.text)) {
		return { spokenInTurn: session.spokenInTurn, effects: [], held: null };
	}

	const spokenInTurn = [...session.spokenInTurn, tag.text];

	if (!isOnScreen) {
		return {
			spokenInTurn,
			effects: [],
			held: { kind: 'line', text: stripTags(tag.text), isAsking: tag.isAsking },
		};
	}

	return {
		spokenInTurn,
		held: null,
		effects: [
			{
				type: 'speak',
				text: cleanSessionLine(tag.text),
				source: 'narrator',
				ref: session.ref,
				isNamed: true,
				priority: 'high',
				// The developer asked for this work: a newer line about the session never drops it.
				isOwed: true,
				isHoldable: true,
				...(tag.isAsking ? { isAsking: true } : {}),
			},
		],
	};
};

import type { Session } from '../shared/protocol.js';
import { cleanSpokenText } from '../shared/spoken.js';
import { readSpokenTag } from '../shared/spoken-tags.js';
import type { Effect } from './reducer.js';

export interface SpokenLines {
	spokenInTurn: string[];
	effects: Effect[];
}

export const speakNewTag = (session: Session, text: string): SpokenLines => {
	// A message's line is said as soon as its tag closes, from the stream or the finished message, once.
	const tag = readSpokenTag(text);

	if (!tag || session.spokenInTurn.includes(tag.text)) {
		return { spokenInTurn: session.spokenInTurn, effects: [] };
	}

	return {
		spokenInTurn: [...session.spokenInTurn, tag.text],
		effects: [
			{
				type: 'speak',
				text: cleanSpokenText(tag.text),
				source: 'narrator',
				ref: session.ref,
				isNamed: true,
				priority: 'high',
				// The developer asked for this work: a newer line about the session never drops it.
				isOwed: true,
				...(tag.isAsking ? { isAsking: true } : {}),
			},
		],
	};
};

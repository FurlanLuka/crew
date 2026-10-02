// What a line Voice OS says about its own action ("Sent to checkout. Switch there?") is about, carried
// on the speak effect so a small model can word it (voice-lines/). The reducer still decides whether
// the line is said and which offer is open; the wording only changes how it sounds, and the fixed
// text it replaces is always there to fall back on.
export type FollowUpFacts =
	// The developer's words went to that session.
	| { kind: 'sent'; label: string; offersSwitch: boolean }
	// The words wait for the session's current work. Its name is put in front in code when needed, so
	// the worded line must not say it: label is what it must leave out.
	| { kind: 'queued'; label: string; offersSwitch: boolean }
	| { kind: 'switching'; label: string }
	// skipped: sessions passed over on the way back because they stopped.
	| { kind: 'back'; label: string; skipped: string[] }
	// hasWaitingWords: the developer's words go to it once it is up. Always asks to switch there.
	| { kind: 'activated'; label: string; hasWaitingWords: boolean };

export const offersSwitch = (facts: FollowUpFacts): boolean => {
	switch (facts.kind) {
		case 'sent':
		case 'queued':
			return facts.offersSwitch;
		case 'activated':
			return true;
		case 'switching':
		case 'back':
			return false;
	}
};

// Every name the line must say word for word: a worded line that drops or changes one is not used.
export const listFollowUpLabels = (facts: FollowUpFacts): string[] => {
	switch (facts.kind) {
		case 'queued':
			return [];
		case 'back':
			return [facts.label, ...facts.skipped];
		case 'sent':
		case 'switching':
		case 'activated':
			return [facts.label];
	}
};

// "Switch there?" appended to the line that already says where the words went.
export const withSwitchOffered = (facts: FollowUpFacts): FollowUpFacts =>
	facts.kind === 'sent' || facts.kind === 'queued' ? { ...facts, offersSwitch: true } : facts;

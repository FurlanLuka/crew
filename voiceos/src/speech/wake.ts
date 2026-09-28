// On demand, Voice OS acts only on what follows its name. Speech-to-text writes the name several
// ways ("Voice OS", "VoiceOS", "voice o s"); a "hey" or "okay" before it is part of the call.
const WAKE_PATTERN = /\b(?:(?:hey|okay|ok)[,\s]+)?voice[\s.,]*o\.?\s*s\b/i;

const NAME_HEAD_PATTERN = /^(?:(?:hey|okay|ok)[,\s]+)?voice[\s.,!?]*$/i;
const NAME_TAIL_PATTERN = /^o\.?\s*s\b[\s.,!?:;—–-]*/i;

// The words after the wake phrase, or null when it is not there.
export const findWakePhrase = (text: string): string | null => {
	const match = WAKE_PATTERN.exec(text);

	return match
		? text
				.slice(match.index + match[0].length)
				.replace(/^[\s.,!?:;—–-]+/, '')
				.trim()
		: null;
};

// A call split across segments ("Voice" | "OS, open the doc") joins back with the name in front: it
// comes off before the turn is sent. Only in front: later in the sentence it is the developer's word.
export const stripLeadingWakePhrase = (text: string): string => {
	const match = WAKE_PATTERN.exec(text);

	return match && match.index === 0 ? (findWakePhrase(text) ?? text) : text;
};

export type GateResult =
	// Asleep and not called: left alone.
	| { kind: 'drop' }
	// Called: a turn opens with what came after the name (possibly nothing yet).
	| { kind: 'wake'; rest: string }
	// Awake: the words are the turn's, the name taken out if it was said again. isNameHead: the
	// segment was only "Voice", so an "OS" starting the next one is the rest of the name.
	| { kind: 'pass'; text: string; isNameHead?: true };

interface GateHeardParams {
	isAwake: boolean;
	text: string;
	// The segment before was only "Voice".
	isAfterNameHead?: boolean;
}

export const gateHeard = ({
	isAwake,
	text,
	isAfterNameHead = false,
}: GateHeardParams): GateResult => {
	const rest = findWakePhrase(text);

	// Called already, the name only comes off in front: "check the voice os logs" keeps its words.
	// Speech-to-text can also split the name across two segments ("Voice" | "OS, open the doc"):
	// either half on its own at the start is the name, not the developer's words.
	if (isAwake) {
		const words = stripLeadingWakePhrase(text);

		if (NAME_HEAD_PATTERN.test(words)) {
			return { kind: 'pass', text: '', isNameHead: true };
		}

		return {
			kind: 'pass',
			text: isAfterNameHead ? words.replace(NAME_TAIL_PATTERN, '') : words,
		};
	}

	return rest === null ? { kind: 'drop' } : { kind: 'wake', rest };
};

// A delivered turn read against the audio: which frames were the developer's speech (to learn
// from), and what the gate would have done with it (to measure a threshold).

// One 32 ms frame as the stream heard it. at: when it arrived, in ms.
export interface RingFrame {
	at: number;
	prob: number;
	// Voice OS was playing speech then: the open mic may have heard it, so it is never learned.
	isVoiceOsSpeaking: boolean;
	samples: Float32Array;
}

export interface SpeechInSpanParams {
	ring: RingFrame[];
	from: number;
	to: number;
	speechOn: number;
}

export interface SpanSpeech {
	audio: Float32Array;
	frames: number;
	// Speech frames left out because Voice OS was speaking over them.
	skipped: number;
}

export const speechInSpan = ({ ring, from, to, speechOn }: SpeechInSpanParams): SpanSpeech => {
	const inSpan = ring.filter(
		(frame) => frame.at >= from && frame.at <= to && frame.prob >= speechOn,
	);
	const kept = inSpan.filter((frame) => !frame.isVoiceOsSpeaking);
	const audio = new Float32Array(kept.reduce((sum, frame) => sum + frame.samples.length, 0));
	let offset = 0;

	for (const frame of kept) {
		audio.set(frame.samples, offset);
		offset += frame.samples.length;
	}

	return { audio, frames: kept.length, skipped: inSpan.length - kept.length };
};

// A listened turn's start is when its first transcript arrived, about half a second after the words
// began: anything reading audio by a turn's span pads its start by this much.
export const TURN_PAD_MS = 1_000;

// A gate score placed on the stream's clock.
export interface TimedScore {
	at: number;
	score: number;
	kind: 'first' | 'recheck';
	accepted: boolean;
}

export interface ScoreTurnParams {
	scores: TimedScore[];
	from: number;
	to: number;
	// The first words reach the turn's start about half a second after they were said.
	padMs: number;
}

export type TurnVerdict = 'kept' | 'silenced' | 'unscored';

export interface ScoredTurn {
	scores: TimedScore[];
	verdict: TurnVerdict;
}

// The gate's state at the turn's end is what it would have done to the words that became the turn.
export const scoreTurn = ({ scores, from, to, padMs }: ScoreTurnParams): ScoredTurn => {
	const inTurn = scores.filter((score) => score.at >= from - padMs && score.at <= to);
	const last = inTurn.at(-1);

	return {
		scores: inTurn,
		verdict: last === undefined ? 'unscored' : last.accepted ? 'kept' : 'silenced',
	};
};

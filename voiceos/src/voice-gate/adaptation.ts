// Learning goes on after lock-in: the enrollment heard the developer read aloud for half a minute,
// their commands sound different. Only turns that are clearly theirs are folded in, and the
// voiceprint stays anchored to whoever enrolled, so a partner or a video never pulls it away.

import type { ListenMode } from '../shared/protocol.js';
import { cosine, normalizedMean } from './enrollment.js';
import { DEFAULT_GATE_CONFIG } from './gate.js';

// What the gate would keep rather than silence.
export const KEPT_MIN_SCORE = DEFAULT_GATE_CONFIG.threshold;
// A held key says someone meant to talk to Voice OS, not who: it lowers the bar, down to what the
// gate itself would keep, never below.
export const PUSH_MIN_SCORE = KEPT_MIN_SCORE;
export const LISTENED_MIN_SCORE = 0.6;
export const MIN_ENROLLED_SCORE = 0.5;
// Trained: the developer's last RECENT_TURNS turns all reached TRAINED_MIN_SCORE and averaged
// TRAINED_AVERAGE. From then on learning slows; it never stops.
export const TRAINED_MIN_SCORE = 0.6;
export const TRAINED_AVERAGE = 0.8;
export const LEARNING_WEIGHT = 0.2;
export const TRAINED_WEIGHT = 0.05;
export const RECENT_TURNS = 10;

export const rollingAverage = (scores: number[]): number | null => {
	const recent = scores.slice(-RECENT_TURNS);

	return recent.length === 0 ? null : recent.reduce((sum, score) => sum + score, 0) / recent.length;
};

// recentScores: the developer's turns (countsAsDeveloper), learned from or not.
export const isTrained = (recentScores: number[]): boolean => {
	const recent = recentScores.slice(-RECENT_TURNS);

	return (
		recent.length === RECENT_TURNS &&
		recent.every((score) => score >= TRAINED_MIN_SCORE) &&
		// Scores are kept to three decimals: ten 0.8s must average 0.8, not 0.7999….
		Math.round((rollingAverage(recent) ?? 0) * 1000) / 1000 >= TRAINED_AVERAGE
	);
};

export interface TurnScores {
	// The turn against the voiceprint as it is, before any blending.
	turnScore: number;
	// The turn against the voiceprint as it was locked in.
	enrolledScore: number;
}

// A turn the gate would keep, near whoever enrolled, is the developer's: it counts toward "trained"
// even when it is not clear enough to learn from, so a weak turn holds training back honestly.
export const countsAsDeveloper = ({ turnScore, enrolledScore }: TurnScores): boolean =>
	turnScore >= KEPT_MIN_SCORE && enrolledScore >= MIN_ENROLLED_SCORE;

export interface DecideAdaptationParams extends TurnScores {
	source: ListenMode;
	isTrained: boolean;
}

export type Adaptation =
	| { kind: 'learn'; weight: number }
	| { kind: 'skip'; reason: 'not clearly the developer' | 'far from enrollment' };

export const decideAdaptation = ({
	turnScore,
	enrolledScore,
	source,
	isTrained,
}: DecideAdaptationParams): Adaptation => {
	const minScore = source === 'push' ? PUSH_MIN_SCORE : LISTENED_MIN_SCORE;

	if (turnScore < minScore) {
		return { kind: 'skip', reason: 'not clearly the developer' };
	}

	if (enrolledScore < MIN_ENROLLED_SCORE) {
		return { kind: 'skip', reason: 'far from enrollment' };
	}

	return { kind: 'learn', weight: isTrained ? TRAINED_WEIGHT : LEARNING_WEIGHT };
};

// The voiceprint moved toward the turn by weight, kept unit length.
export const blend = (
	voiceprint: Float32Array,
	turn: Float32Array,
	weight: number,
): Float32Array => {
	const mixed = voiceprint.map(
		(value, index) => (1 - weight) * value + weight * (turn[index] ?? 0),
	);
	const length = Math.hypot(...mixed);

	return length === 0 ? mixed : mixed.map((value) => value / length);
};

// What is learned, and what a restart resumes from.
export interface LearnedVoice {
	voiceprint: Float32Array;
	enrolled: Float32Array;
	// The developer's recent turns (countsAsDeveloper), three decimals.
	recentScores: number[];
	turns: number;
}

export interface AdaptVoiceParams {
	voice: LearnedVoice;
	// The turn's chunk embeddings.
	embeddings: Float32Array[];
	source: ListenMode;
}

export interface AdaptedVoice {
	voice: LearnedVoice;
	decision: Adaptation;
	scores: TurnScores;
	isDeveloper: boolean;
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

// One turn against the voice: scored before it is blended in, counted when it is the developer's,
// learned from when it is clearly theirs.
export const adaptVoice = ({ voice, embeddings, source }: AdaptVoiceParams): AdaptedVoice => {
	const turn = normalizedMean(embeddings);
	const scores = {
		turnScore: cosine(turn, voice.voiceprint),
		enrolledScore: cosine(turn, voice.enrolled),
	};
	const decision = decideAdaptation({
		...scores,
		source,
		isTrained: isTrained(voice.recentScores),
	});
	const isDeveloper = countsAsDeveloper(scores);

	if (!isDeveloper) {
		return { voice, decision, scores, isDeveloper };
	}

	return {
		voice: {
			...voice,
			voiceprint:
				decision.kind === 'learn'
					? blend(voice.voiceprint, turn, decision.weight)
					: voice.voiceprint,
			recentScores: [...voice.recentScores, round(scores.turnScore)].slice(-RECENT_TURNS),
			turns: voice.turns + (decision.kind === 'learn' ? 1 : 0),
		},
		decision,
		scores,
		isDeveloper,
	};
};

// The trained rule in words, for the page.
export const TRAINED_RULE = `until your last ${RECENT_TURNS} turns all reach ${TRAINED_MIN_SCORE} and average ${TRAINED_AVERAGE}`;

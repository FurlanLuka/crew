import type { VoiceGateStatus } from '../shared/protocol.js';
import { TRAINED_RULE } from '../voice-gate/adaptation.js';

export interface VoiceGateChip {
	label: string;
	title: string;
	// A voice is learned: the chip offers to forget it.
	canForget: boolean;
}

const formatScore = (score: number): string => score.toFixed(2);

type ScoringStatus = Extract<VoiceGateStatus, { phase: 'scoring' }>;

const describeScoring = ({
	lastScore,
	turnScore,
	average,
	isTrained,
}: ScoringStatus): VoiceGateChip => {
	// The whole turn when it was long enough to score whole (3 s of speech): a short window is noisy.
	const shown = turnScore ?? lastScore;
	// No turn scored yet in this run (just locked in, or resumed after a restart).
	const score = shown === null ? '' : ` ${formatScore(shown)}`;
	const which =
		turnScore !== null
			? 'Your last turn as a whole against your voice (1 is you).'
			: 'Your last words against your voice (1 is you).';
	const recent = average === null ? '' : ` Your recent turns average ${formatScore(average)}.`;
	const progress = isTrained
		? 'Trained: it keeps learning, slowly.'
		: `Still learning, ${TRAINED_RULE}.`;

	return {
		label: isTrained ? `voice${score || ' learned'}` : `voice${score} · learning`,
		title: `${which}${recent} ${progress} Nothing is filtered yet. Click to forget your voice.`,
		canForget: true,
	};
};

// The bottom bar's one line about the voice gate: short on the bar, the meaning on hover. Hidden
// where there is nothing the developer can act on (the log says why).
export const describeVoiceGate = (status: VoiceGateStatus | null): VoiceGateChip | null => {
	switch (status?.phase) {
		case 'preparing':
			return status.isDownloading
				? {
						label: 'voice models…',
						title: 'Downloading the models that learn your voice (once, about 90 MB)',
						canForget: false,
					}
				: null;
		// Shown from 0 s: after "forget my voice" the chip must visibly start over.
		case 'learning':
			return {
				label: `voice ${status.seconds}/${status.of} s`,
				title: 'Learning your voice from what you say to Voice OS',
				canForget: false,
			};
		case 'scoring':
			return describeScoring(status);
		default:
			return null;
	}
};

export const FORGET_VOICE_CONFIRM =
	'Forget your voice? Voice OS will learn it again from what you say.';

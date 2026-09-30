import type { VoiceGateStatus } from '../shared/protocol.js';

export interface VoiceGateChip {
	label: string;
	title: string;
}

// The bottom bar's one line about the voice gate: short on the bar, the meaning on hover. Hidden
// where there is nothing to show yet or nothing the developer can act on (the log says why).
export const describeVoiceGate = (status: VoiceGateStatus | null): VoiceGateChip | null => {
	switch (status?.phase) {
		case 'preparing':
			return status.isDownloading
				? {
						label: 'voice models…',
						title: 'Downloading the models that learn your voice (once, about 90 MB)',
					}
				: null;
		case 'learning':
			return status.seconds > 0
				? {
						label: `voice ${status.seconds}/${status.of} s`,
						title: 'Learning your voice from what you say to Voice OS',
					}
				: null;
		case 'scoring':
			return {
				label: status.lastScore === null ? 'voice learned' : `voice ${status.lastScore.toFixed(2)}`,
				title:
					'Your last turn scored against your voice (1 is you). Nothing is filtered yet: this only measures',
			};
		default:
			return null;
	}
};

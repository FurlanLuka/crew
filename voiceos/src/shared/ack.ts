// What Voice OS itself says when it passes words to a session: only what the session cannot say,
// because it has not seen them yet. The session acks and reports in its own spoken lines.

// inactive: nothing starts it; the words wait until it is activated.
export type SendTiming = 'now' | 'queued' | 'starting' | 'inactive';

export interface SendAck {
	kind: 'question' | 'instruction' | 'redirect';
}

export const composeAckText = ({ kind }: SendAck, timing: SendTiming): string | null => {
	switch (timing) {
		// Sent now, the session sees the words and acks them itself.
		case 'now':
			return null;
		case 'queued':
			// A question to a working session is asked aside; one queued on purpose waits unannounced.
			return kind === 'question' ? null : 'Okay, after its current work.';
		case 'starting':
			return 'Starting it up.';
		case 'inactive':
			return "Kept for it; it isn't active.";
	}
};

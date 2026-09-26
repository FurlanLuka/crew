// What Voice OS itself says when it passes words to a session: only what the session cannot say,
// because it has not seen them yet. The session acks and reports in its own spoken lines.

export type SendTiming = 'now' | 'queued' | 'starting';

export interface SendAck {
	kind: 'question' | 'instruction';
}

export const composeAckText = ({ kind }: SendAck, timing: SendTiming): string | null => {
	switch (timing) {
		// Sent now, the session sees the words and acks them itself.
		case 'now':
			return null;
		case 'queued':
			// A question to a working session is asked aside; one queued on purpose waits unannounced.
			return kind === 'instruction' ? 'Okay, after its current work.' : null;
		case 'starting':
			return 'Starting it up.';
	}
};

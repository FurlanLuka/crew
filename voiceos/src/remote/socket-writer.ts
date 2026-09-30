// A socket takes what it can; the rest waits for its drain, in order. Images make lines of
// megabytes, so a partial write is the normal case, not an edge.

export interface WritableSocket {
	// Bytes taken; -1 or 0 when none were.
	write: (bytes: Uint8Array) => number;
}

export interface SocketWriter {
	write: (bytes: Uint8Array) => void;
	// Call on the socket's drain.
	drain: () => void;
	readonly waiting: number;
}

export const createSocketWriter = (socket: WritableSocket): SocketWriter => {
	const pending: Uint8Array[] = [];

	const drain = (): void => {
		while (pending.length > 0) {
			const next = pending[0];

			if (!next) {
				return;
			}

			const written = socket.write(next);

			if (written < next.length) {
				pending[0] = next.subarray(Math.max(written, 0));

				return;
			}

			pending.shift();
		}
	};

	return {
		write: (bytes) => {
			pending.push(bytes);

			if (pending.length === 1) {
				drain();
			}
		},
		drain,
		get waiting() {
			return pending.reduce((total, bytes) => total + bytes.length, 0);
		},
	};
};

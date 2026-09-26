export const PRE_ROLL_MS = 300;
export const TAIL_MS = 250;

export interface PushResult {
	send: Int16Array[];
	shouldStop: boolean;
}

export interface ListenResult {
	shouldStopFirst: boolean;
}

export interface PressParams {
	withPreRoll?: boolean;
}

export interface PressResult {
	preRoll: Int16Array[];
	shouldStopFirst: boolean;
}

type PttPhase = 'idle' | 'talking' | 'tail' | 'listening';

export class PttBuffer {
	private ring: Int16Array[] = [];
	private ringSamples = 0;
	private phase: PttPhase = 'idle';
	private tailSamplesLeft = 0;

	constructor(
		private sampleRate: number,
		private preRollMs = PRE_ROLL_MS,
		private tailMs = TAIL_MS,
	) {}

	get isTalking(): boolean {
		return this.phase === 'talking' || this.phase === 'tail';
	}

	listen(): ListenResult {
		// Hands-free takes over from a press, held or in its tail, which ends now.
		const shouldStopFirst = this.isTalking;
		this.ring = [];
		this.ringSamples = 0;
		this.phase = 'listening';

		return { shouldStopFirst };
	}

	unlisten(): void {
		if (this.phase === 'listening') {
			this.phase = 'idle';
		}
	}

	press({ withPreRoll = true }: PressParams = {}): PressResult {
		// The same audio already streams hands-free.
		if (this.phase === 'listening') {
			return { preRoll: [], shouldStopFirst: false };
		}

		// A press in the previous tail ends it now: two utterances never share a stream.
		const shouldStopFirst = this.phase === 'tail';
		// The pre-roll holds the syllable spoken as the key went down, unless speech just played.
		const preRoll = withPreRoll ? this.ring : [];
		this.ring = [];
		this.ringSamples = 0;
		this.phase = 'talking';

		return { preRoll, shouldStopFirst };
	}

	release(): void {
		if (this.phase !== 'talking') {
			return;
		}

		// The tail keeps the last word from being cut off.
		this.phase = 'tail';
		this.tailSamplesLeft = Math.round((this.sampleRate * this.tailMs) / 1000);
	}

	push(chunk: Int16Array): PushResult {
		switch (this.phase) {
			case 'idle':
				this.keepPreRoll(chunk);

				return { send: [], shouldStop: false };
			case 'talking':
			case 'listening':
				return { send: [chunk], shouldStop: false };

			case 'tail': {
				this.tailSamplesLeft -= chunk.length;

				if (this.tailSamplesLeft > 0) {
					return { send: [chunk], shouldStop: false };
				}

				this.phase = 'idle';

				return { send: [chunk], shouldStop: true };
			}
		}
	}

	private keepPreRoll(chunk: Int16Array): void {
		this.ring.push(chunk);
		this.ringSamples += chunk.length;
		const preRollSamples = Math.round((this.sampleRate * this.preRollMs) / 1000);

		while (
			this.ring.length > 1 &&
			this.ringSamples - (this.ring[0]?.length ?? 0) >= preRollSamples
		) {
			this.ringSamples -= this.ring.shift()?.length ?? 0;
		}
	}
}

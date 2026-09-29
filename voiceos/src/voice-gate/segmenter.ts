// The mic's speech cut into segments for the recordings: where speech opens and closes by the same
// VAD thresholds the gate uses, with a little padding, and never longer than a recording should be.

import { DEFAULT_GATE_CONFIG, FRAME, SAMPLE_RATE } from './gate.js';
import type { RingFrame } from './turns.js';

const framesFor = (ms: number): number => Math.round((ms / 1000) * (SAMPLE_RATE / FRAME));

export interface SegmenterConfig {
	speechOn: number;
	speechOff: number;
	hangoverFrames: number;
	padFrames: number;
	// Speech frames, padding not counted.
	minSpeechFrames: number;
	maxFrames: number;
}

export const DEFAULT_SEGMENTER_CONFIG: SegmenterConfig = {
	speechOn: DEFAULT_GATE_CONFIG.speechOn,
	speechOff: DEFAULT_GATE_CONFIG.speechOff,
	hangoverFrames: DEFAULT_GATE_CONFIG.hangoverFrames,
	padFrames: framesFor(300),
	minSpeechFrames: framesFor(500),
	// Continuous background talk never pauses: a recording is split rather than grown past this.
	maxFrames: framesFor(15_000),
};

export class Segmenter {
	private config: SegmenterConfig;
	private lead: RingFrame[] = [];
	private open: RingFrame[] | null = null;
	private speechFrames = 0;
	private quiet = 0;
	private lastSpeechIndex = 0;

	constructor(config: Partial<SegmenterConfig> = {}) {
		this.config = { ...DEFAULT_SEGMENTER_CONFIG, ...config };
	}

	// Returns the segments this frame closed.
	push(frame: RingFrame): RingFrame[][] {
		if (!this.open) {
			if (frame.prob < this.config.speechOn) {
				this.lead.push(frame);

				if (this.lead.length > this.config.padFrames) {
					this.lead.shift();
				}

				return [];
			}

			this.open = [...this.lead, frame];
			this.lead = [];
			this.speechFrames = 1;
			this.quiet = 0;
			this.lastSpeechIndex = this.open.length - 1;

			return [];
		}

		this.open.push(frame);

		if (frame.prob >= this.config.speechOff) {
			this.speechFrames += 1;
			this.quiet = 0;
			this.lastSpeechIndex = this.open.length - 1;
		} else {
			this.quiet += 1;
		}

		// Split at the length limit: the next segment starts without lead-in, fine for a recording.
		if (this.quiet > this.config.hangoverFrames || this.open.length >= this.config.maxFrames) {
			return this.close();
		}

		return [];
	}

	// The audio stops being continuous (a reset, dropped frames, the tab gone): what is open ends here.
	close(): RingFrame[][] {
		const open = this.open;

		this.open = null;
		this.lead = [];

		if (!open || this.speechFrames < this.config.minSpeechFrames) {
			return [];
		}

		return [open.slice(0, this.lastSpeechIndex + 1 + this.config.padFrames)];
	}
}

// The voice gate's state machine, ported from the research prototype (research/voice-gate/gate.py)
// as is: mic frames in, the frames to forward out — the enrolled speaker's audio unchanged,
// everyone else as silence of the same length.
//
// Silence instead of dropping keeps the stream's timeline real, so the recognizer's own endpointing
// still works (Soniox bills stream time either way). The output lags the input by the preroll plus,
// at an utterance's start, the decision window; it is flushed in one burst once the verdict is in.

export const SAMPLE_RATE = 16_000;
// 32 ms: the only chunk size Silero VAD accepts at 16 kHz.
export const FRAME = 512;

export interface GateConfig {
	threshold: number;
	// A mid-utterance flip must clear the threshold by this much, so a score hovering around it does
	// not chop one speaker's sentence into pieces.
	hysteresis: number;
	speechOn: number;
	speechOff: number;
	// ~400 ms of quiet ends an utterance.
	hangoverFrames: number;
	// ~200 ms before VAD fires, so first syllables survive.
	prerollFrames: number;
	// ~800 ms of speech: ECAPA is unreliable on less.
	decideFrames: number;
	// Shorter bursts (coughs, clicks) are dropped unscored.
	minFrames: number;
	// ~1 s between re-scores inside an utterance.
	recheckFrames: number;
	// ~1.5 s of recent speech is what gets scored.
	windowFrames: number;
	// A flip needs the median of this many latest scores past the threshold, so one odd window cannot
	// cut a sentence. 1: the latest score alone.
	flipMedianOf: number;
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
	threshold: 0.4,
	hysteresis: 0.05,
	speechOn: 0.5,
	speechOff: 0.35,
	hangoverFrames: 12,
	prerollFrames: 6,
	decideFrames: 25,
	minFrames: 12,
	recheckFrames: 31,
	windowFrames: 47,
	flipMedianOf: 1,
};

// An utterance's opening decision, or a flip after a re-check.
export interface Verdict {
	accepted: boolean;
	score: number;
	isFirst: boolean;
}

// Every score the gate took, flips or not: what a threshold is later picked from.
// frame: the 1-based count of frames pushed when it was taken.
export interface GateScore {
	score: number;
	kind: 'first' | 'recheck';
	accepted: boolean;
	frame: number;
}

export type Scorer = (audio: Float32Array) => Promise<number>;

const silence = (frame: Float32Array): Float32Array => new Float32Array(frame.length);

// With an even count the middle value on the staying side is taken: two windows, one of them odd,
// never flip the verdict on their own.
const medianFor = (values: number[], isAccepted: boolean | null): number => {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = (sorted.length - 1) / 2;

	return sorted[isAccepted ? Math.ceil(middle) : Math.floor(middle)] ?? 0;
};

const concat = (frames: Float32Array[]): Float32Array => {
	const joined = new Float32Array(frames.reduce((sum, frame) => sum + frame.length, 0));
	let offset = 0;

	for (const frame of frames) {
		joined.set(frame, offset);
		offset += frame.length;
	}

	return joined;
};

export class Gate {
	readonly verdicts: Verdict[] = [];
	readonly scores: GateScore[] = [];
	private config: GateConfig;
	private preroll: Float32Array[] = [];
	private window: Float32Array[] = [];
	private pending: Float32Array[] = [];
	private inSpeech = false;
	private accepted: boolean | null = null;
	private voiced = 0;
	private quiet = 0;
	private sinceCheck = 0;
	private pushed = 0;
	// This utterance's scores, for flipMedianOf.
	private utteranceScores: number[] = [];

	constructor(
		private score: Scorer,
		config: Partial<GateConfig> = {},
	) {
		this.config = { ...DEFAULT_GATE_CONFIG, ...config };
	}

	// The accepted state of the utterance under way; null outside one or before its verdict.
	get isAccepted(): boolean | null {
		return this.inSpeech ? this.accepted : null;
	}

	// Scores taken since the last call: a stream that never pauses keeps one gate for hours.
	takeScores(): GateScore[] {
		return this.scores.splice(0);
	}

	// The audio stopped with an utterance still undecided (a released key): it is scored as a pause
	// would have scored it, instead of waiting for frames that never come.
	async finish(): Promise<void> {
		if (!this.inSpeech || this.accepted !== null) {
			return;
		}

		await this.endUndecided();
	}

	// Frames must be pushed one at a time, each after the previous push resolved.
	async push(frame: Float32Array, speechProb: number): Promise<Float32Array[]> {
		this.pushed += 1;

		return this.inSpeech ? this.speaking(frame, speechProb) : this.idle(frame, speechProb);
	}

	private idle(frame: Float32Array, prob: number): Float32Array[] {
		if (prob < this.config.speechOn) {
			this.preroll.push(frame);

			if (this.preroll.length > this.config.prerollFrames) {
				return [silence(this.preroll.shift() as Float32Array)];
			}

			return [];
		}

		this.inSpeech = true;
		this.utteranceScores = [];
		this.accepted = null;
		this.voiced = 1;
		this.quiet = 0;
		this.sinceCheck = 0;
		this.pending = [...this.preroll, frame];
		this.preroll = [];
		this.window = [frame];

		return [];
	}

	private async speaking(frame: Float32Array, prob: number): Promise<Float32Array[]> {
		if (prob >= this.config.speechOff) {
			this.quiet = 0;
			this.voiced += 1;
			this.addToWindow(frame);
			this.sinceCheck += 1;
		} else {
			this.quiet += 1;
		}

		if (this.accepted === null) {
			this.pending.push(frame);

			if (this.voiced >= this.config.decideFrames) {
				return this.decide();
			}

			if (this.quiet > this.config.hangoverFrames) {
				return this.endUndecided();
			}

			return [];
		}

		if (this.sinceCheck >= this.config.recheckFrames) {
			await this.recheck();
		}

		const out = [this.accepted ? frame : silence(frame)];

		if (this.quiet > this.config.hangoverFrames) {
			this.inSpeech = false;
		}

		return out;
	}

	private addToWindow(frame: Float32Array): void {
		this.window.push(frame);

		if (this.window.length > this.config.windowFrames) {
			this.window.shift();
		}
	}

	private async decide(): Promise<Float32Array[]> {
		const score = await this.score(concat(this.window));

		this.utteranceScores.push(score);
		this.accepted = score >= this.config.threshold;
		this.verdicts.push({ accepted: this.accepted, score, isFirst: true });
		this.scores.push({ score, kind: 'first', accepted: this.accepted, frame: this.pushed });
		this.sinceCheck = 0;

		return this.flush();
	}

	private async endUndecided(): Promise<Float32Array[]> {
		let out: Float32Array[];

		if (this.voiced >= this.config.minFrames) {
			out = await this.decide();
		} else {
			this.accepted = false;
			out = this.flush();
		}

		this.inSpeech = false;

		return out;
	}

	private async recheck(): Promise<void> {
		this.sinceCheck = 0;

		const score = await this.score(concat(this.window));
		const { threshold, hysteresis } = this.config;

		this.utteranceScores.push(score);

		const judged = medianFor(this.utteranceScores.slice(-this.config.flipMedianOf), this.accepted);
		const isFlipped = this.accepted
			? judged < threshold - hysteresis
			: judged >= threshold + hysteresis;

		if (isFlipped) {
			this.accepted = !this.accepted;
			this.verdicts.push({ accepted: this.accepted, score, isFirst: false });
		}

		this.scores.push({
			score,
			kind: 'recheck',
			accepted: this.accepted ?? false,
			frame: this.pushed,
		});
	}

	private flush(): Float32Array[] {
		const out = this.accepted ? this.pending : this.pending.map(silence);

		this.pending = [];

		return out;
	}
}

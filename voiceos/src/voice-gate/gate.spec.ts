import { describe, expect, it } from 'bun:test';
import golden from './testdata/gate-golden.json';
import { DEFAULT_GATE_CONFIG, FRAME, Gate, type Scorer } from './gate.js';

const SPEECH = 0.9;
const QUIET = 0;

type Script = [value: number, prob: number, count: number][];

// The frame value stands in for who is speaking; the scorer reads the latest frame.
const scoreByValue =
	(scores: Record<string, number>): Scorer =>
	(audio) => {
		const key = String(Math.round((audio.at(-1) ?? 0) * 100) / 100);
		const score = scores[key];

		if (score === undefined) {
			throw new Error(`no score for ${key}`);
		}

		return Promise.resolve(score);
	};

const run = async (gate: Gate, script: Script): Promise<number[]> => {
	const out: number[] = [];

	for (const [value, prob, count] of script) {
		for (let index = 0; index < count; index++) {
			const frames = await gate.push(new Float32Array(FRAME).fill(value), prob);

			out.push(...frames.map((frame) => Math.round((frame[0] ?? 0) * 100) / 100));
		}
	}

	return out;
};

const countOf = (values: number[], value: number): number =>
	values.filter((each) => each === value).length;

describe('Gate', () => {
	it('enrolled speaker → passes unchanged, and the timeline is kept', async () => {
		const gate = new Gate(scoreByValue({ '0.5': 0.8 }));
		const out = await run(gate, [
			[0.01, QUIET, 20],
			[0.5, SPEECH, 60],
			[0.01, QUIET, 30],
		]);
		const { prerollFrames, hangoverFrames } = DEFAULT_GATE_CONFIG;

		expect(countOf(out, 0.5)).toBe(60);
		// Room tone inside the utterance (preroll, trailing pause) passes as is; outside it, zeros.
		expect(countOf(out, 0.01)).toBe(prerollFrames + hangoverFrames + 1);
		expect(countOf(out, 0)).toBe(110 - 60 - countOf(out, 0.01) - prerollFrames);
		// Only the preroll is still held.
		expect(out).toHaveLength(110 - prerollFrames);
		expect(gate.verdicts.map((verdict) => verdict.accepted)).toEqual([true]);
	});

	it('other speaker → silenced', async () => {
		const gate = new Gate(scoreByValue({ '0.3': 0.1 }));
		const out = await run(gate, [
			[0.3, SPEECH, 60],
			[0, QUIET, 30],
		]);

		expect(out.every((value) => value === 0)).toBe(true);
		expect(gate.verdicts.map((verdict) => verdict.accepted)).toEqual([false]);
	});

	it('burst under the minimum → dropped, never scored', async () => {
		const gate = new Gate(() => Promise.reject(new Error('scored a burst')));
		const out = await run(gate, [
			[0.4, SPEECH, 5],
			[0, QUIET, 30],
		]);

		expect(out.every((value) => value === 0)).toBe(true);
		expect(gate.scores).toEqual([]);
	});

	it('speaker change without a pause → the gate flips', async () => {
		const gate = new Gate(scoreByValue({ '0.5': 0.8, '0.3': 0.1 }));
		const out = await run(gate, [
			[0.5, SPEECH, 40],
			[0.3, SPEECH, 80],
			[0, QUIET, 30],
		]);

		expect(gate.verdicts.map((verdict) => verdict.accepted)).toEqual([true, false]);
		expect(out.slice(-40)).not.toContain(0.3);
	});

	it('a score near the threshold → no flip, but the recheck is still recorded', async () => {
		const gate = new Gate(scoreByValue({ '0.5': 0.8, '0.3': 0.38 }));

		await run(gate, [
			[0.5, SPEECH, 40],
			[0.3, SPEECH, 80],
		]);

		expect(gate.verdicts.map((verdict) => verdict.accepted)).toEqual([true]);
		expect(gate.scores.filter((score) => score.kind === 'recheck').map((s) => s.score)).toContain(
			0.38,
		);
	});

	it('rejected, then the enrolled speaker → flips back to accepted', async () => {
		const gate = new Gate(scoreByValue({ '0.5': 0.8, '0.3': 0.1 }));

		await run(gate, [
			[0.3, SPEECH, 40],
			[0.5, SPEECH, 80],
		]);

		expect(gate.verdicts.map((verdict) => [verdict.accepted, verdict.isFirst])).toEqual([
			[false, true],
			[true, false],
		]);
	});

	it('undecided utterance of at least the minimum → scored when it ends', async () => {
		const gate = new Gate(scoreByValue({ '0.5': 0.8 }));
		const out = await run(gate, [
			[0.5, SPEECH, 15],
			[0.01, QUIET, 20],
		]);

		expect(gate.scores.map((score) => score.kind)).toEqual(['first']);
		expect(countOf(out, 0.5)).toBe(15);
	});

	it('one first score, then one per recheck interval of speech', async () => {
		const gate = new Gate(scoreByValue({ '0.5': 0.8 }));
		const { decideFrames, recheckFrames } = DEFAULT_GATE_CONFIG;

		await run(gate, [[0.5, SPEECH, decideFrames + 3 * recheckFrames]]);

		expect(gate.scores.map((score) => score.kind)).toEqual([
			'first',
			'recheck',
			'recheck',
			'recheck',
		]);
		expect(gate.scores.map((score) => score.frame)).toEqual([
			decideFrames,
			decideFrames + recheckFrames,
			decideFrames + 2 * recheckFrames,
			decideFrames + 3 * recheckFrames,
		]);
	});

	it('the prototype’s own run → the same verdicts and the same forwarded frames', async () => {
		const gate = new Gate(scoreByValue(golden.scores));
		const out = await run(gate, golden.script as Script);

		expect(gate.verdicts).toEqual(golden.verdicts);
		expect(out).toEqual(golden.out);
	});

	it('finish() on speech shorter than the minimum → dropped, never scored', async () => {
		const gate = new Gate(() => Promise.reject(new Error('scored a burst')));

		await run(gate, [[0.5, SPEECH, 8]]);
		await gate.finish();

		expect(gate.scores).toEqual([]);
		expect(gate.isAccepted).toBeNull();
	});

	it('finish() on an utterance long enough but undecided → scored now', async () => {
		const gate = new Gate(scoreByValue({ '0.5': 0.8 }));

		await run(gate, [[0.5, SPEECH, 15]]);
		await gate.finish();

		expect(gate.scores.map((score) => [score.kind, score.accepted])).toEqual([['first', true]]);
	});

	it('finish() on an utterance already decided, or outside speech → nothing new', async () => {
		const gate = new Gate(scoreByValue({ '0.5': 0.8 }));

		await gate.finish();
		await run(gate, [[0.5, SPEECH, 30]]);
		await gate.finish();

		expect(gate.scores).toHaveLength(1);
	});
});

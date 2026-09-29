import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeWav } from '../speech/wav.js';
import { FRAME } from './gate.js';
import { deleteRecordings, RECORDING_WAIT_MS, Recorder, type RecorderCaps } from './recorder.js';
import { captureLog } from './test-support.js';
import type { RingFrame } from './turns.js';

const WAIT_MS = RECORDING_WAIT_MS;

let dir: string;
let clock: number;
let readLog: () => Record<string, unknown>[];

const framesAt = (from: number, count: number, value = 0.25): RingFrame[] =>
	Array.from({ length: count }, (_, index) => ({
		at: from + index * 32,
		prob: 0.9,
		isVoiceOsSpeaking: false,
		samples: new Float32Array(FRAME).fill(value),
	}));

const recorder = (caps?: RecorderCaps) =>
	new Recorder({ dir, now: () => clock, waitMs: WAIT_MS, caps });

const segment = (from: number, count = 31, client = 'c1') => ({
	client,
	sampleRate: 48_000,
	frames: framesAt(from, count),
	scores: [{ at: from + 500, score: 0.71, kind: 'first' as const, accepted: true }],
	voiceprintTurns: 4,
});

const pairs = () => readdirSync(dir).filter((name) => name.endsWith('.json'));
const meta = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'));

beforeEach(() => {
	dir = join(mkdtempSync(join(tmpdir(), 'voice-recordings-')), 'recordings');
	clock = 1_000_000;
	readLog = captureLog();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('Recorder', () => {
	it('a segment a turn claims, even one delivered 30 s later → saved as turn, with its text', () => {
		const record = recorder();

		record.add(segment(clock - 2_000));
		clock += 29_000;
		record.tick();
		expect(pairs()).toEqual([]);

		clock += 1_000;
		record.markTurn({
			client: 'c1',
			from: 998_300,
			to: 999_200,
			source: 'hands-free',
			text: 'run the tests',
		});
		clock += WAIT_MS;
		record.tick();

		const [name] = pairs();

		expect(name).toContain('-turn');
		expect(meta(name as string)).toMatchObject({
			label: 'turn',
			at: 998_000,
			seconds: (31 * FRAME) / 16_000,
			client: 'c1',
			micSampleRate: 48_000,
			turns: [{ source: 'hands-free', text: 'run the tests' }],
			voiceprintTurns: 4,
			scores: [{ kind: 'first', score: 0.71 }],
		});
	});

	it('no turn by the end of the wait → saved as other; not before', () => {
		const record = recorder();

		record.add(segment(clock));
		clock += WAIT_MS - 1;
		record.tick();
		expect(pairs()).toEqual([]);

		clock += 1;
		record.tick();
		expect(meta(pairs()[0] as string).label).toBe('other');
	});

	it('another tab’s turn → does not claim this tab’s segment', () => {
		const record = recorder();

		record.add(segment(clock, 31, 'c1'));
		record.markTurn({ client: 'c2', from: clock, to: clock + 1_000, source: 'push', text: 'x' });
		clock += WAIT_MS;
		record.tick();

		expect(meta(pairs()[0] as string).label).toBe('other');
	});

	it('two turns over one segment → both listed; coverage unpadded, overlaps counted once', () => {
		const record = recorder();
		const from = clock;

		record.add(segment(from, 100));
		record.markTurn({
			client: 'c1',
			from: from + 1_000,
			to: from + 1_500,
			source: 'hands-free',
			text: 'a',
		});
		record.markTurn({
			client: 'c1',
			from: from + 1_300,
			to: from + 2_400,
			source: 'hands-free',
			text: 'b',
		});
		clock += WAIT_MS;
		record.tick();

		const saved = meta(pairs()[0] as string);

		expect(saved.turns).toHaveLength(2);
		// 1000–2400 of a 3200 ms segment: the claim's padding decides the label only.
		expect(saved.turnCoverage).toBe(0.438);
	});

	it('the WAV → 16 kHz int16 of the frames, loud samples clamped; per-frame probs and flags beside', () => {
		const record = recorder();
		const frames = framesAt(clock, 2, 0.5);

		(frames[1] as RingFrame).samples[0] = 1.5;
		record.add({ ...segment(clock), frames });
		clock += WAIT_MS;
		record.tick();

		const name = pairs()[0] as string;
		const samples = decodeWav(
			new Uint8Array(readFileSync(join(dir, name.replace('.json', '.wav')))),
		);

		expect(samples.length).toBe(2 * FRAME);
		expect(samples[0]).toBe(Math.round(0.5 * 32767));
		expect(samples[FRAME]).toBe(32767);
		expect(meta(name)).toMatchObject({ probs: [0.9, 0.9], voiceOsSpeaking: [false, false] });
	});

	it('files and folder → readable by the owner only, even a folder that was already open', () => {
		mkdirSync(dir, { recursive: true });
		chmodSync(dir, 0o755);

		const record = recorder();

		record.add(segment(clock));
		clock += WAIT_MS;
		record.tick();

		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(readdirSync(dir)).toHaveLength(2);
		expect(
			readdirSync(dir).every((name) => (statSync(join(dir, name)).mode & 0o777) === 0o600),
		).toBe(true);
	});

	it('two segments of one tab starting at the same instant → two recordings, none overwritten', () => {
		const record = recorder();

		record.add(segment(clock, 31, 'c1'));
		record.add(segment(clock, 31, 'c1'));
		clock += WAIT_MS;
		record.tick();

		expect(pairs()).toHaveLength(2);
	});

	it('over a label’s cap → its oldest pair removed, both files; the other label and stray files kept', () => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'notes.txt'), 'mine');

		const record = recorder({ turn: 2, other: 1, bytes: 1e9 });
		const start = clock;

		for (let index = 0; index < 3; index++) {
			record.add(segment(start + index * 10_000));
			record.markTurn({
				client: 'c1',
				from: start + index * 10_000,
				to: start + index * 10_000 + 500,
				source: 'push',
				text: '',
			});
		}

		record.add(segment(start + 90_000));
		clock += 90_000 + WAIT_MS;
		record.tick();

		const saved = pairs().map((name) => meta(name));

		expect(
			saved
				.filter((entry) => entry.label === 'turn')
				.map((entry) => entry.at)
				.sort(),
		).toEqual([start + 10_000, start + 20_000]);
		expect(saved.filter((entry) => entry.label === 'other')).toHaveLength(1);
		expect(readdirSync(dir).filter((name) => name.endsWith('.wav'))).toHaveLength(3);
		expect(readdirSync(dir)).toContain('notes.txt');
		expect(readLog().some((line) => line.msg === 'recordings capped')).toBe(true);
	});

	it('over the size cap → oldest removed until it fits, the newest kept', () => {
		const record = recorder({ turn: 100, other: 100, bytes: 60_000 });
		const start = clock;

		for (let index = 0; index < 3; index++) {
			record.add(segment(start + index * 1_000));
		}

		clock += WAIT_MS + 5_000;
		record.tick();

		expect(pairs().map((name) => meta(name).at)).toEqual([start + 2_000]);
		expect(readdirSync(dir).filter((name) => name.endsWith('.wav'))).toHaveLength(1);
	});

	it('recordings from an earlier run → counted toward the caps', () => {
		const first = recorder({ turn: 100, other: 2, bytes: 1e9 });

		first.add(segment(clock));
		first.add(segment(clock + 1_000));
		clock += WAIT_MS + 1_000;
		first.tick();

		const second = recorder({ turn: 100, other: 2, bytes: 1e9 });

		expect(second.files).toBe(2);
		second.add(segment(clock));
		clock += WAIT_MS;
		second.tick();
		expect(pairs()).toHaveLength(2);
	});

	it('a write that fails → logged, and the next recording still saved', () => {
		const record = recorder();

		record.add(segment(clock));
		chmodSync(dir, 0o500);
		clock += WAIT_MS;
		record.tick();
		chmodSync(dir, 0o700);

		expect(readLog().some((line) => line.msg === 'recording not saved')).toBe(true);

		record.add(segment(clock));
		clock += WAIT_MS;
		record.tick();
		expect(pairs()).toHaveLength(1);
	});

	it('the JSON write failing → its WAV removed too, nothing half-saved', () => {
		const record = recorder();
		const from = clock;

		record.add(segment(from));
		clock += WAIT_MS;

		const stamp = new Date(from).toISOString().replace(/[:.]/g, '-');

		// A folder where the JSON should go makes only its write fail.
		mkdirSync(join(dir, `${stamp}-c1-1-other.json`));
		record.tick();

		expect(readdirSync(dir).filter((name) => name.endsWith('.wav'))).toEqual([]);
		expect(readLog().some((line) => line.msg === 'recording not saved')).toBe(true);
	});

	it('the log line → says what was recorded, never the words', () => {
		const record = recorder();

		record.add(segment(clock));
		record.markTurn({
			client: 'c1',
			from: clock,
			to: clock + 500,
			source: 'push',
			text: 'secret words',
		});
		clock += WAIT_MS;
		record.tick();

		expect(readLog().find((line) => line.msg === 'recorded')).toMatchObject({ label: 'turn' });
		expect(JSON.stringify(readLog())).not.toContain('secret words');
	});

	it('scores the stream trims after the segment closed → still in its recording', () => {
		const record = recorder();
		const live = segment(clock);

		record.add(live);
		clock += 10_000;
		record.tick();
		// The stream trims its list long before the recording is saved.
		live.scores.length = 0;
		clock += WAIT_MS;
		record.tick();

		expect(meta(pairs()[0] as string).scores).toHaveLength(1);
	});

	it('forget → every recording and everything waiting deleted', () => {
		const record = recorder();

		record.add(segment(clock));
		clock += WAIT_MS;
		record.tick();
		record.add(segment(clock));
		record.deleteAll();
		clock += WAIT_MS;
		record.tick();

		expect(readdirSync(dir)).toEqual([]);
	});

	it('deleting the recordings → every WAV and JSON in the folder, indexed or not; other files kept', () => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'orphan.wav'), 'x');
		writeFileSync(join(dir, 'notes.txt'), 'mine');

		deleteRecordings(dir);

		expect(readdirSync(dir)).toEqual(['notes.txt']);
	});
});

import { beforeEach, describe, expect, it } from 'bun:test';
import type { VoiceGateStatus } from '../shared/protocol.js';
import type { Embed } from './models.js';
import { captureLog, DEVELOPER, fakeEmbed, fakeVads, OTHER, pcm, QUIET } from './test-support.js';
import { type HeardTurn, VoiceGate } from './voice-gate.js';

let clock: number;
let statuses: VoiceGateStatus[];
let readLog: () => Record<string, unknown>[];

interface CreateGateParams {
	embed?: Embed;
	vads?: ReturnType<typeof fakeVads>;
	isVoiceOsSpeaking?: () => boolean;
}

const createGate = (params: CreateGateParams = {}) =>
	new VoiceGate({
		createVad: (params.vads ?? fakeVads()).createVad,
		embed: params.embed ?? fakeEmbed,
		setStatus: (status) => statuses.push(status),
		now: () => clock,
		isVoiceOsSpeaking: params.isVoiceOsSpeaking ?? (() => false),
	});

// A push-to-talk turn: level for ms in 100 ms chunks, then some quiet before the key is released;
// returns its span.
const say = (
	gate: VoiceGate,
	client: string,
	level: number,
	ms: number,
	quietMs = 600,
): HeardTurn => {
	const from = clock;

	for (let sent = 0; sent < ms; sent += 100) {
		gate.observe(client, pcm(level, 100), 16_000);
		clock += 100;
	}

	for (let sent = 0; sent < quietMs; sent += 100) {
		gate.observe(client, pcm(QUIET, 100), 16_000);
		clock += 100;
	}

	return { from, to: clock, source: 'push' };
};

const learnVoice = async (gate: VoiceGate, client = 'c1') => {
	for (let turn = 0; turn < 8; turn++) {
		await gate.turnDelivered(client, say(gate, client, DEVELOPER, 4_000));
	}
};

const lines = (message: string) => readLog().filter((line) => line.msg === message);

beforeEach(() => {
	clock = 1_000_000;
	statuses = [];
	readLog = captureLog();
});

describe('VoiceGate', () => {
	it('about 30 s of the developer’s turns → learning, then scoring', async () => {
		const gate = createGate();

		await learnVoice(gate);

		expect(statuses[0]).toEqual({ phase: 'learning', seconds: 0, of: 30 });
		expect(statuses.filter((status) => status.phase === 'learning').map((s) => s.seconds)).toEqual([
			0, 4, 8, 12, 16, 20, 24, 28,
		]);
		expect(statuses.at(-1)).toEqual({ phase: 'scoring', lastScore: null });
		expect(lines('locked in')).toHaveLength(1);
	});

	it('scoring → the developer’s next turn is kept, logged with its source and scores', async () => {
		const gate = createGate();

		await learnVoice(gate);
		await gate.turnDelivered('c1', say(gate, 'c1', DEVELOPER, 2_000));

		expect(lines('turn scored').at(-1)).toMatchObject({
			client: 'c1',
			source: 'push',
			verdict: 'kept',
			scores: [1, 1],
		});
		expect(statuses.at(-1)).toEqual({ phase: 'scoring', lastScore: 1 });
	});

	it('scoring → another tab hearing someone else is scored on the same voiceprint', async () => {
		const gate = createGate();

		await learnVoice(gate);
		await gate.turnDelivered('c2', say(gate, 'c2', OTHER, 2_000));

		expect(lines('turn scored').at(-1)).toMatchObject({ client: 'c2', verdict: 'silenced' });
		expect(statuses.at(-1)).toEqual({ phase: 'scoring', lastScore: 0 });
	});

	it('a turn delivered while its audio is still with the models → learned in full', async () => {
		const gate = createGate({ vads: fakeVads(() => 1) });

		await gate.turnDelivered('c1', say(gate, 'c1', DEVELOPER, 3_500));

		// Whole 32 ms frames: 3.5 s is 109 of them.
		expect(lines('learn').at(-1)?.speechSeconds).toBeCloseTo(3.5, 1);
	});

	it('someone else talking before a turn → not learned; only the turn’s span is', async () => {
		const gate = createGate();

		say(gate, 'c1', OTHER, 3_000);
		await gate.turnDelivered('c1', say(gate, 'c1', DEVELOPER, 1_000));

		expect(lines('learn').at(-1)?.speechSeconds).toBeCloseTo(1, 1);
	});

	it('learned turns after lock-in → scored, the voiceprint unchanged', async () => {
		const gate = createGate();

		await learnVoice(gate);
		await gate.turnDelivered('c1', say(gate, 'c1', OTHER, 4_000));
		await gate.turnDelivered('c1', say(gate, 'c1', DEVELOPER, 2_000));

		expect(lines('learn')).toHaveLength(8);
		expect(lines('locked in')).toHaveLength(1);
		expect(statuses.at(-1)).toEqual({ phase: 'scoring', lastScore: 1 });
	});

	it('a turn too short to score → unscored, and the chip keeps its last score', async () => {
		const gate = createGate();

		await learnVoice(gate);
		await gate.turnDelivered('c1', say(gate, 'c1', DEVELOPER, 200));

		expect(lines('turn scored').at(-1)).toMatchObject({ verdict: 'unscored', scores: [] });
		expect(statuses.at(-1)).toEqual({ phase: 'scoring', lastScore: null });
	});

	it('a turn with no speech → the same status is not sent again', async () => {
		const gate = createGate();

		await gate.turnDelivered('c1', say(gate, 'c1', QUIET, 1_000));
		await gate.turnDelivered('c1', say(gate, 'c1', QUIET, 1_000));

		expect(statuses).toEqual([{ phase: 'learning', seconds: 0, of: 30 }]);
	});

	it('typed words (no audio from that tab) → nothing learned', async () => {
		const gate = createGate();

		await gate.turnDelivered('c9', { from: 0, to: clock, source: 'push' });

		expect(lines('learn')).toEqual([]);
	});

	it('forget while its chunk is being embedded → no throw, the stream is gone', async () => {
		let release = () => {};
		let entered = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const isEmbedding = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = createGate({
			embed: async (audio) => {
				entered();
				await held;

				return fakeEmbed(audio);
			},
		});
		const learning = gate.turnDelivered('c1', say(gate, 'c1', DEVELOPER, 3_500));

		await isEmbedding;
		gate.forget('c1');
		release();
		await learning;

		expect(lines('forget')).toMatchObject([{ client: 'c1' }]);
		await gate.turnDelivered('c1', { from: 0, to: clock, source: 'push' });
		expect(lines('learn')).toHaveLength(1);
	});

	it('the log → never carries audio or an embedding', async () => {
		const gate = createGate();

		await learnVoice(gate);
		await gate.turnDelivered('c1', say(gate, 'c1', DEVELOPER, 2_000));

		const longArrays = readLog().flatMap((line) =>
			Object.values(line).filter((value) => Array.isArray(value) && value.length >= 64),
		);

		expect(longArrays).toEqual([]);
	});

	it('speech while Voice OS is talking → never learned, and counted as skipped', async () => {
		const gate = createGate({ isVoiceOsSpeaking: () => true });

		await gate.turnDelivered('c1', say(gate, 'c1', DEVELOPER, 3_000));

		expect(lines('learn').at(-1)).toMatchObject({ speechSeconds: 0 });
		expect(Number(lines('learn').at(-1)?.skippedWhileSpeaking)).toBeGreaterThan(0);
		expect(statuses).toEqual([{ phase: 'learning', seconds: 0, of: 30 }]);
	});

	it('a turn waiting behind the one that locks in → scored, not learned', async () => {
		const gate = createGate();

		for (let turn = 0; turn < 7; turn++) {
			await gate.turnDelivered('c1', say(gate, 'c1', DEVELOPER, 4_000));
		}

		const locking = say(gate, 'c1', DEVELOPER, 4_000);

		// Heard as a live mic would be: seven seconds at once would trip the backlog cap.
		await Bun.sleep(1);

		const waiting = say(gate, 'c1', DEVELOPER, 2_000);

		await Promise.all([gate.turnDelivered('c1', locking), gate.turnDelivered('c1', waiting)]);

		expect(lines('locked in')).toHaveLength(1);
		expect(lines('learn')).toHaveLength(8);
		expect(lines('turn scored')).toHaveLength(1);
	});

	it('the model failing on one turn → that turn lost, later turns still learned', async () => {
		let calls = 0;
		const gate = createGate({
			embed: (audio) => {
				calls += 1;

				return calls === 1 ? Promise.reject(new Error('model broke')) : fakeEmbed(audio);
			},
		});

		await expect(gate.turnDelivered('c1', say(gate, 'c1', DEVELOPER, 4_000))).rejects.toThrow(
			'model broke',
		);
		await learnVoice(gate);

		expect(statuses.at(-1)).toEqual({ phase: 'scoring', lastScore: null });
	});

	it('a short press released right after the words → still scored, not unscored', async () => {
		const gate = createGate();

		await learnVoice(gate);
		await gate.turnDelivered('c1', say(gate, 'c1', DEVELOPER, 500, 0));

		expect(lines('turn scored').at(-1)).toMatchObject({ verdict: 'kept', scores: [1] });
	});

	it('the next press already under way when a turn is read → its words are not cut short', async () => {
		const gate = createGate();

		await learnVoice(gate);

		const first = say(gate, 'c1', DEVELOPER, 2_000);

		// Pressed again at once, before the first press's words came back from speech-to-text: 0.6 s is
		// long enough to be scored, too short to have been decided yet.
		say(gate, 'c1', DEVELOPER, 600, 0);
		await gate.turnDelivered('c1', first);
		await gate.turnDelivered('c1', say(gate, 'c1', DEVELOPER, 2_000));

		const firsts = lines('score').filter((line) => line.kind === 'first');

		// One for the first press, one for the second press running on into the third. Cut short, the
		// second would have been decided on its own and scored twice over.
		expect(firsts).toHaveLength(2);
	});
});

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeWav } from './wav.js';
import { Store } from '../state/store.js';
import type { SttSessionOptions } from './stt.js';
import { VoiceInput, type VoiceInputOptions } from './voice-in.js';
import { computeReconnectDelay } from './hands-free.js';
import { configureLog } from '../log.js';

configureLog({ quiet: true });

// A finished hands-free turn waits this long before it is routed, in case the sentence goes on.
const CONTINUE_MS = 2;
const waitForSettle = () => Bun.sleep(CONTINUE_MS + 8);

type HarnessExtras = Pick<
	VoiceInputOptions,
	| 'listSpokenLines'
	| 'now'
	| 'computeReconnectDelay'
	| 'quietMs'
	| 'holdMs'
	| 'continueMs'
	| 'maxWaitMs'
>;

interface CreateHarnessParams extends HarnessExtras {
	apiKey?: string | null;
	debugAudioDir?: string | null;
	maxPressMs?: number;
}

const createHarness = ({
	apiKey = 'k',
	debugAudioDir = null,
	maxPressMs,
	...extra
}: CreateHarnessParams = {}) => {
	const store = new Store();
	store.dispatch({
		type: 'worktrees',
		worktrees: [
			{
				ref: 'store-front/main',
				label: 'store-front/main',
				branch: '',
				cwd: '/w',
				dirs: [],
				isPinned: false,
			},
		],
	});
	const utterances: string[] = [];
	const startedAts: number[] = [];
	const talkStarts: number[] = [];
	const talkEnds: number[] = [];
	let session: SttSessionOptions | null = null;
	const sessions: SttSessionOptions[] = [];
	const sent: number[] = [];
	let ended = false;
	const cancelled: number[] = [];
	const listenOffs: { client: string; reason: string }[] = [];
	const input = new VoiceInput({
		continueMs: CONTINUE_MS,
		...extra,
		onListenOff: (client, reason) => listenOffs.push({ client, reason }),
		store,
		apiKey,
		onUtterance: (text, _client, startedAt) => {
			utterances.push(text);
			startedAts.push(startedAt);
		},
		onTalkStart: () => talkStarts.push(1),
		onTalkEnd: () => talkEnds.push(1),
		debugAudioDir,
		maxPressMs,
		createSession: (options) => {
			session = options;
			const index = sessions.push(options) - 1;

			return {
				send: (chunk) => sent.push(chunk.byteLength),
				end: async () => {
					ended = true;
				},
				cancel: () => {
					cancelled.push(index);
				},
			};
		},
	});

	return {
		store,
		input,
		utterances,
		startedAts,
		talkStarts,
		talkEnds,
		sent,
		sessions,
		cancelled,
		listenOffs,
		get session() {
			return session;
		},
		get ended() {
			return ended;
		},
	};
};

describe('VoiceInput', () => {
	it('press → context terms include worktree names; talking stops playback', () => {
		const harness = createHarness();
		harness.input.start('c1');
		expect(harness.session?.terms).toContain('store front main');
		expect(harness.talkStarts).toHaveLength(1);
	});

	it('partial → transcript, visible to every client, headed for Voice OS', () => {
		const harness = createHarness();
		harness.input.start('c1');
		harness.session?.onPartial('store-front/main, run');
		expect(harness.store.state.transcript).toEqual({
			text: 'store-front/main, run',
			isFinal: false,
			target: '→ Voice OS',
		});
	});

	it('release → stream ended; final → transcript cleared and the utterance routed', async () => {
		const harness = createHarness();
		harness.input.start('c1');
		harness.input.pushAudio('c1', new Uint8Array(3200));
		harness.input.stop('c1');
		expect(harness.sent).toEqual([3200]);
		expect(harness.ended).toBe(true);

		harness.session?.onFinal('open store-front/main');
		expect(harness.store.state.transcript).toBeNull();
		expect(harness.utterances).toEqual(['open store-front/main']);
	});

	it('each utterance carries when it began: the press, not the final', () => {
		let clock = 1000;
		const harness = createHarness({ now: () => clock });
		harness.input.start('c1');
		clock = 4000;
		harness.input.stop('c1');
		harness.session?.onFinal('open store-front/main');
		harness.input.start('c1');
		harness.session?.onFinal('and run the tests');

		expect(harness.startedAts).toEqual([1000, 4000]);
	});

	it('silence → no utterance', () => {
		const harness = createHarness();
		harness.input.start('c1');
		harness.session?.onFinal('   ');
		expect(harness.utterances).toEqual([]);
	});

	it('no Soniox key → spoken hint, no stream opened', () => {
		const harness = createHarness({ apiKey: null });
		harness.input.start('c1');
		expect(harness.session).toBeNull();
		expect(harness.store.state.spoken.at(-1)?.text).toContain('Soniox');
	});

	it('stt error → transcript cleared and the failure spoken', () => {
		const harness = createHarness();
		harness.input.start('c1');
		harness.session?.onPartial('open');
		harness.session?.onError('Soniox 401: bad key', 'soniox');
		expect(harness.store.state.transcript).toBeNull();
		expect(harness.store.state.spoken.at(-1)?.text).toContain('Soniox 401');
	});

	it('the browser rate goes to Soniox', () => {
		const harness = createHarness();
		harness.input.start('c1', 48000);
		expect(harness.session?.sampleRate).toBe(48000);
	});

	it('press again while the last utterance finalizes → both kept apart, both routed', () => {
		const harness = createHarness();
		harness.input.start('c1');
		harness.input.stop('c1');
		const [first] = harness.sessions;
		harness.input.start('c1');
		const second = harness.sessions[1];
		expect(harness.cancelled).toEqual([]);

		second?.onPartial('open store');
		first?.onPartial('stale words');
		expect(harness.store.state.transcript?.text).toBe('open store');

		first?.onFinal('why is this so slow');
		expect(harness.utterances).toEqual(['why is this so slow']);
		expect(harness.store.state.transcript?.text).toBe('open store');

		second?.onFinal('open store-front/main');
		expect(harness.utterances).toEqual(['why is this so slow', 'open store-front/main']);
		expect(harness.store.state.transcript).toBeNull();
	});

	it('audio after release → not sent to the finalizing stream', () => {
		const harness = createHarness();
		harness.input.start('c1');
		harness.input.stop('c1');
		harness.input.pushAudio('c1', new Uint8Array(10));
		expect(harness.sent).toEqual([]);
	});

	it('debug audio on → the utterance is saved as a WAV at its rate, with its transcript', () => {
		const directory = mkdtempSync(join(tmpdir(), 'voiceos-debug-'));
		const harness = createHarness({ debugAudioDir: directory });
		harness.input.start('c1', 48000);
		harness.input.pushAudio('c1', new Uint8Array(9600));
		harness.input.stop('c1');
		harness.session?.onFinal('why is this so slow');

		const files = readdirSync(directory);
		const wav = files.find((file) => file.endsWith('.wav')) ?? '';
		const samples = decodeWav(new Uint8Array(readFileSync(join(directory, wav))));
		expect(samples.length).toBe(4800);
		expect(new DataView(readFileSync(join(directory, wav)).buffer).getUint32(24, true)).toBe(48000);
		expect(readFileSync(join(directory, wav.replace('.wav', '.txt')), 'utf8')).toBe(
			'why is this so slow\n',
		);
	});

	it('a quick command that finalizes before the dictation before it → still routed after it, in press order', () => {
		const harness = createHarness();
		harness.input.start('c1');
		harness.input.stop('c1');
		harness.input.start('c1');
		harness.input.stop('c1');
		const [dictation, command] = harness.sessions;

		command?.onFinal('stop');
		expect(harness.utterances).toEqual([]);
		dictation?.onFinal('add a cooldown to the retry');
		expect(harness.utterances).toEqual(['add a cooldown to the retry', 'stop']);
	});

	it('an earlier utterance that errors or hears nothing → the later one is released', () => {
		const harness = createHarness();

		for (let i = 0; i < 3; i++) {
			harness.input.start('c1');
			harness.input.stop('c1');
		}

		const [errored, silent, command] = harness.sessions;
		command?.onFinal('go home');
		errored?.onError('boom', 'connection');
		expect(harness.utterances).toEqual([]);
		silent?.onFinal('  ');
		expect(harness.utterances).toEqual(['go home']);
	});

	it('tab disconnects mid-finalize → the stream is cancelled, nothing routed, the transcript cleared; a late final is ignored', () => {
		const harness = createHarness();
		harness.input.start('c1');
		harness.session?.onPartial('open store');
		harness.input.stop('c1');
		harness.input.disconnect('c1');

		expect(harness.cancelled).toEqual([0]);
		expect(harness.store.state.transcript).toBeNull();
		harness.sessions[0]?.onFinal('open store-front/main');
		expect(harness.utterances).toEqual([]);
	});

	it("one tab disconnecting → another tab's speech still routes", () => {
		const harness = createHarness();
		harness.input.start('c1');
		harness.input.stop('c1');
		harness.input.start('c2');
		harness.input.stop('c2');
		harness.input.disconnect('c1');
		harness.sessions[1]?.onFinal('go home');
		expect(harness.utterances).toEqual(['go home']);
	});

	it("one tab's unfinished speech never holds up another tab", () => {
		const harness = createHarness();
		harness.input.start('c1');
		harness.input.stop('c1');
		harness.input.start('c2');
		harness.input.stop('c2');
		harness.sessions[1]?.onFinal('go home');
		expect(harness.utterances).toEqual(['go home']);
	});

	it("a press never released → dropped after the cap, and the tab's next press is routed", async () => {
		const harness = createHarness({ maxPressMs: 20 });
		harness.input.start('c1');
		await Bun.sleep(40);
		expect(harness.cancelled).toEqual([0]);

		harness.input.start('c1');
		harness.input.stop('c1');
		harness.sessions[1]?.onFinal('go home');
		expect(harness.utterances).toEqual(['go home']);
	});

	it('a released press is not dropped by the cap', async () => {
		const harness = createHarness({ maxPressMs: 20 });
		harness.input.start('c1');
		harness.input.stop('c1');
		await Bun.sleep(40);
		expect(harness.cancelled).toEqual([]);
		harness.sessions[0]?.onFinal('run the tests');
		expect(harness.utterances).toEqual(['run the tests']);
	});

	it('talk ends when the last live press ends — release, cap, abandon or disconnect — and not before', async () => {
		const harness = createHarness({ maxPressMs: 20 });
		harness.input.start('c1');
		harness.input.start('c2');
		harness.input.stop('c1');
		expect(harness.talkEnds).toEqual([]);
		harness.input.stop('c2');
		expect(harness.talkEnds).toEqual([1]);

		harness.input.start('c1');
		await Bun.sleep(40);
		expect(harness.talkEnds).toEqual([1, 1]);

		harness.input.start('c1');
		harness.input.disconnect('c1');
		expect(harness.talkEnds).toEqual([1, 1, 1]);

		harness.input.start('c1');
		harness.input.start('c1');
		expect(harness.talkEnds).toEqual([1, 1, 1]);
		harness.input.stop('c1');
		expect(harness.talkEnds).toEqual([1, 1, 1, 1]);
	});

	it('the transcript shows refs as written; what is routed keeps the words as said', () => {
		const harness = createHarness();
		harness.store.dispatch({
			type: 'worktrees',
			worktrees: [
				{
					ref: 'signals/wrk1',
					label: 'signals/wrk1',
					branch: '',
					cwd: '/w',
					dirs: [],
					isPinned: false,
				},
			],
		});
		harness.input.start('c1');
		harness.session?.onPartial('open signals work one');
		expect(harness.store.state.transcript?.text).toBe('open signals/wrk1');
		harness.input.stop('c1');
		harness.session?.onFinal('open signals work one');
		expect(harness.utterances).toEqual(['open signals work one']);
	});
});

describe('VoiceInput hands-free', () => {
	const createSpoken = (text: string, endedAt: number | null = null) => [{ text, endedAt }];

	it('listen → one segment-mode stream at the tab rate; audio flows to it without a press', () => {
		const harness = createHarness();
		harness.input.listen('c1', 48000);
		expect(harness.sessions).toHaveLength(1);
		expect(harness.session?.sampleRate).toBe(48000);
		expect(harness.session?.onSegment).toBeFunction();
		harness.input.pushAudio('c1', new Uint8Array(960));
		expect(harness.sent).toEqual([960]);
	});

	it('two words of real speech → speech cut once; the turn ends → routed, speech may resume', async () => {
		const harness = createHarness();
		harness.input.listen('c1');
		harness.session?.onPartial('open');
		expect(harness.talkStarts).toEqual([]);
		harness.session?.onPartial('open store');
		harness.session?.onPartial('open store front');
		expect(harness.talkStarts).toEqual([1]);
		expect(harness.store.state.transcript?.text).toBe('open store front');

		harness.session?.onSegment?.('open store front');
		await waitForSettle();
		expect(harness.utterances).toEqual(['open store front']);
		expect(harness.talkEnds).toEqual([1]);
		expect(harness.store.state.transcript).toBeNull();
	});

	it('a one-word turn still cuts in when it ends', async () => {
		const harness = createHarness();
		harness.input.listen('c1');
		harness.session?.onPartial('push');
		expect(harness.talkStarts).toEqual([]);
		harness.session?.onSegment?.('push');
		await waitForSettle();
		expect(harness.talkStarts).toEqual([1]);
		expect(harness.talkEnds).toEqual([1]);
		expect(harness.utterances).toEqual(['push']);
	});

	it('"stop" or "wait" cuts speech the moment it is heard, not when the turn ends', () => {
		const harness = createHarness();
		harness.input.listen('c1');
		harness.session?.onPartial('Stop');
		expect(harness.talkStarts).toEqual([1]);
		harness.session?.onSegment?.('Stop.');
		expect(harness.talkStarts).toEqual([1]);
		expect(harness.utterances).toEqual(['Stop.']);
	});

	it('Voice OS heard through the mic → no barge-in, no transcript, the turn dropped', () => {
		const harness = createHarness({
			listSpokenLines: () => createSpoken('store front, main: tests pass. Want me to push?'),
			now: () => 1000,
		});
		harness.input.listen('c1');
		harness.session?.onPartial('tests pass');
		expect(harness.talkStarts).toEqual([]);
		expect(harness.store.state.transcript).toBeNull();
		harness.session?.onSegment?.('Tests pass. Want me to push?');
		expect(harness.utterances).toEqual([]);
		expect(harness.talkStarts).toEqual([]);
	});

	it('"Allow." leaking as the permission line ends → dropped, never approves', () => {
		const harness = createHarness({
			listSpokenLines: () => createSpoken('checkout wants to run git push. Allow?'),
			now: () => 1000,
		});
		harness.input.listen('c1');
		harness.session?.onSegment?.('Allow.');
		expect(harness.utterances).toEqual([]);
	});

	it("a short answer in the words of the question still playing → routed as the developer's", async () => {
		const harness = createHarness({
			listSpokenLines: () =>
				createSpoken("Which session — signals main that's on screen, or another one?"),
			now: () => 1000,
		});
		harness.input.listen('c1');
		harness.session?.onPartial('signals main');
		harness.session?.onSegment?.('Signals main.');
		await waitForSettle();
		expect(harness.utterances).toEqual(['Signals main.']);
	});

	it('several turns on one stream → each routed in order, the stream kept', async () => {
		const harness = createHarness();
		harness.input.listen('c1');
		harness.session?.onSegment?.('go home');
		await waitForSettle();
		harness.session?.onSegment?.('open store front');
		await waitForSettle();
		expect(harness.utterances).toEqual(['go home', 'open store front']);
		expect(harness.sessions).toHaveLength(1);
		expect(harness.cancelled).toEqual([]);
	});

	it('a turn behind a press still finalizing waits for it', async () => {
		const harness = createHarness();
		harness.input.start('c1');
		harness.input.stop('c1');
		const press = harness.session;
		harness.input.listen('c1');
		harness.session?.onSegment?.('second');
		await waitForSettle();
		expect(harness.utterances).toEqual([]);
		press?.onFinal('first');
		await waitForSettle();
		expect(harness.utterances).toEqual(['first', 'second']);
	});

	it('a press from the listening tab is ignored; audio is sent once', () => {
		const harness = createHarness();
		harness.input.listen('c1');
		harness.input.start('c1');
		expect(harness.sessions).toHaveLength(1);
		expect(harness.talkStarts).toEqual([]);
		harness.input.pushAudio('c1', new Uint8Array(10));
		expect(harness.sent).toEqual([10]);
	});

	it('the stream closes while listening → its words routed, a new stream after the backoff', async () => {
		const harness = createHarness();
		harness.input.listen('c1');
		harness.sessions[0]?.onFinal('half a thought');
		await waitForSettle();
		expect(harness.utterances).toEqual(['half a thought']);
		expect(harness.sessions).toHaveLength(1);
		await Bun.sleep(550);
		expect(harness.sessions).toHaveLength(2);
		harness.input.pushAudio('c1', new Uint8Array(4));
		expect(harness.sent).toEqual([4]);
	});

	it('unlisten → stream cancelled, no reconnect, the tab not told (it asked)', async () => {
		const harness = createHarness();
		harness.input.listen('c1');
		harness.input.unlisten('c1');
		expect(harness.cancelled).toEqual([0]);
		harness.sessions[0]?.onFinal('');
		await Bun.sleep(550);
		expect(harness.sessions).toHaveLength(1);
		expect(harness.listenOffs).toEqual([]);
	});

	it('Soniox refuses the stream → no retry, hands-free off for the tab, said once', () => {
		const harness = createHarness();
		harness.input.listen('c1');
		harness.session?.onError('Soniox 401: bad key', 'soniox');
		expect(harness.listenOffs).toEqual([{ client: 'c1', reason: 'Soniox 401: bad key' }]);
		expect(harness.store.state.spoken.at(-1)?.text).toBe('Hands-free stopped: Soniox 401: bad key');
		harness.input.pushAudio('c1', new Uint8Array(4));
		expect(harness.sent).toEqual([]);
	});

	it('a connection that keeps failing → backs off on the schedule, then gives up and turns hands-free off', async () => {
		// The real schedule, a hundred times faster.
		const delays: number[] = [];
		const harness = createHarness({
			computeReconnectDelay: (attempt) => {
				const delayMs = computeReconnectDelay(attempt);

				if (delayMs !== null) {
					delays.push(delayMs);
				}

				return delayMs === null ? null : delayMs / 100;
			},
		});
		harness.input.listen('c1');

		for (let i = 0; i < 4; i++) {
			harness.sessions.at(-1)?.onError('could not reach Soniox', 'connection');
			await Bun.sleep(50);
		}

		expect(harness.sessions).toHaveLength(5);
		expect(harness.listenOffs).toEqual([]);
		harness.sessions.at(-1)?.onError('could not reach Soniox', 'connection');
		expect(delays).toEqual([500, 1000, 2000, 4000]);
		expect(harness.listenOffs).toHaveLength(1);
		expect(harness.listenOffs[0]?.reason).toContain('keeps dropping');
	});

	it('a stream that works again resets the backoff', async () => {
		const attempts: number[] = [];
		const harness = createHarness({
			computeReconnectDelay: (attempt) => {
				attempts.push(attempt);

				return 1;
			},
		});
		harness.input.listen('c1');
		harness.sessions.at(-1)?.onError('dropped', 'connection');
		await Bun.sleep(10);
		harness.sessions.at(-1)?.onPartial('hello there');
		harness.sessions.at(-1)?.onError('dropped', 'connection');
		expect(attempts).toEqual([0, 0]);
	});

	it('another tab turns hands-free on → the first is stopped and told', () => {
		const harness = createHarness();
		harness.input.listen('c1');
		harness.input.listen('c2');
		expect(harness.cancelled).toEqual([0]);
		expect(harness.listenOffs).toEqual([
			{ client: 'c1', reason: 'hands-free moved to another tab' },
		]);
		harness.input.pushAudio('c1', new Uint8Array(4));
		harness.input.pushAudio('c2', new Uint8Array(8));
		expect(harness.sent).toEqual([8]);
	});

	it('the tab goes away mid-turn → stream cancelled, speech released', () => {
		const harness = createHarness();
		harness.input.listen('c1');
		harness.session?.onPartial('open the store');
		harness.input.disconnect('c1');
		expect(harness.cancelled).toEqual([0]);
		expect(harness.talkEnds).toEqual([1]);
	});

	it('speech stays held while a press is live, even when a hands-free turn ends', async () => {
		const harness = createHarness();
		harness.input.listen('c1');
		harness.input.start('c2');
		harness.sessions[0]?.onPartial('open the store');
		harness.sessions[0]?.onSegment?.('open the store');
		await waitForSettle();
		expect(harness.talkEnds).toEqual([]);
		harness.input.stop('c2');
		expect(harness.talkEnds).toEqual([1]);
	});

	it("answering in the line's own words after it ended → routed, not dropped as echo", async () => {
		const harness = createHarness({
			listSpokenLines: () => createSpoken('store front went down. Want Claude to fix it?', 6000),
			now: () => 10_000,
		});
		harness.input.listen('c1');
		harness.session?.onPartial('fix it');
		expect(harness.talkStarts).toEqual([1]);
		harness.session?.onSegment?.('Fix it.');
		await waitForSettle();
		expect(harness.utterances).toEqual(['Fix it.']);
	});

	it('a turn that never ends (background talk) → speech released after the quiet time; new words keep it held', async () => {
		const harness = createHarness({ quietMs: 40 });
		harness.input.listen('c1');
		harness.session?.onPartial('open the');
		await Bun.sleep(25);
		harness.session?.onPartial('open the store');
		await Bun.sleep(25);
		expect(harness.talkEnds).toEqual([]);
		await Bun.sleep(40);
		expect(harness.talkEnds).toEqual([1]);
		harness.session?.onSegment?.('open the store');
		await waitForSettle();
		expect(harness.utterances).toEqual(['open the store']);
		expect(harness.talkStarts).toEqual([1, 1]);
		expect(harness.talkEnds).toEqual([1, 1]);
	});
});

describe('VoiceInput hands-free: unfinished turns', () => {
	const HOLD_MS = 80;

	const createHeldHarness = (extra: HarnessExtras = {}) => {
		const harness = createHarness({ holdMs: HOLD_MS, ...extra });
		harness.input.listen('c1');

		return harness;
	};

	it('a turn cut off mid-thought waits, and the next one completes it', async () => {
		const harness = createHeldHarness();
		harness.session?.onSegment?.('Switch to—');
		expect(harness.utterances).toEqual([]);
		expect(harness.store.state.transcript).toEqual({
			text: 'Switch to—',
			isFinal: false,
			target: 'waiting for the rest…',
		});
		harness.session?.onSegment?.('checkout api main.');
		await waitForSettle();
		expect(harness.utterances).toEqual(['Switch to checkout api main.']);
		expect(harness.store.state.transcript).toBeNull();
	});

	it('speech stays held while waiting for the rest; it resumes once the turn is complete', async () => {
		const harness = createHeldHarness();
		harness.session?.onSegment?.('And can you.');
		expect(harness.talkStarts).toEqual([1]);
		expect(harness.talkEnds).toEqual([]);
		harness.session?.onSegment?.('Restart the dev servers?');
		await waitForSettle();
		expect(harness.talkEnds).toEqual([1]);
	});

	it('the continuation is shown joined to the held start while it is spoken', () => {
		const harness = createHeldHarness();
		harness.session?.onSegment?.('And can you.');
		harness.session?.onPartial('restart the');
		expect(harness.store.state.transcript).toEqual({
			text: 'And can you restart the',
			isFinal: false,
			target: 'waiting for the rest…',
		});
	});

	it('a continuation that starts inside the wait and ends after it is still joined', async () => {
		const harness = createHeldHarness();
		harness.session?.onSegment?.('And can you.');
		await Bun.sleep(HOLD_MS / 2);
		harness.session?.onPartial('restart the');
		await Bun.sleep(HOLD_MS / 2 + 20);
		harness.session?.onPartial('restart the dev servers');
		await Bun.sleep(HOLD_MS / 2 + 20);
		harness.session?.onSegment?.('restart the dev servers');
		await waitForSettle();
		expect(harness.utterances).toEqual(['And can you restart the dev servers']);
	});

	it('a joined turn began with its first words', async () => {
		let clock = 1000;
		const harness = createHeldHarness({ now: () => clock });
		harness.session?.onPartial("Let's");
		harness.session?.onSegment?.("Let's, um.");
		clock = 3000;
		harness.session?.onPartial('open');
		harness.session?.onSegment?.('open checkout.');
		await waitForSettle();

		expect(harness.utterances).toEqual(["Let's, um open checkout."]);
		expect(harness.startedAts).toEqual([1000]);
	});

	it('two fragments in a row, then the rest → one utterance', async () => {
		const harness = createHeldHarness();
		harness.session?.onSegment?.("Let's, um.");
		await Bun.sleep(HOLD_MS / 2);
		harness.session?.onSegment?.('and can you');
		await Bun.sleep(HOLD_MS / 2 + 20);
		harness.session?.onSegment?.('open checkout.');
		await waitForSettle();
		expect(harness.utterances).toEqual(["Let's, um and can you open checkout."]);
	});

	it('silence after a fragment → it goes on as it is (the kernel ignores a real fragment), speech released', async () => {
		const harness = createHeldHarness();
		harness.session?.onSegment?.('And can you.');
		await Bun.sleep(HOLD_MS + 30);
		expect(harness.utterances).toEqual(['And can you.']);
		expect(harness.talkEnds).toEqual([1]);
		expect(harness.store.state.transcript).toBeNull();
	});

	it('Voice OS heard back while waiting → the wait is untouched', async () => {
		const harness = createHeldHarness({
			listSpokenLines: () => [{ text: 'dev servers are already up.', endedAt: null }],
			now: () => 1000,
		});
		harness.session?.onSegment?.('And can you.');
		harness.session?.onSegment?.('dev servers are already up');
		await waitForSettle();
		expect(harness.utterances).toEqual([]);
		expect(harness.store.state.transcript?.text).toBe('And can you.');
		harness.session?.onSegment?.('restart them');
		await waitForSettle();
		expect(harness.utterances).toEqual(['And can you restart them']);
	});

	it('an echoed fragment is never held', () => {
		const harness = createHeldHarness({
			listSpokenLines: () => [{ text: 'Want me to push, or', endedAt: null }],
			now: () => 1000,
		});
		harness.session?.onSegment?.('want me to push or');
		expect(harness.store.state.transcript).toBeNull();
	});

	it.each(['Hold on.', 'Stop.'])('%p is acted on at once, never held', (text) => {
		const harness = createHeldHarness();
		harness.session?.onSegment?.(text);
		expect(harness.utterances).toEqual([text]);
	});

	it.each(['Yes.', 'Show me everything.', 'Okay.'])(
		'%p waits a moment in case it goes on, then is acted on',
		async (text) => {
			const harness = createHeldHarness();
			harness.session?.onSegment?.(text);
			expect(harness.utterances).toEqual([]);
			expect(harness.talkEnds).toEqual([]);
			expect(harness.store.state.transcript?.target).not.toBe('waiting for the rest…');
			await waitForSettle();
			expect(harness.utterances).toEqual([text]);
			expect(harness.talkEnds).toEqual([1]);
		},
	);

	it('unlisten, disconnect or a failed stream drop the wait; nothing arrives late', async () => {
		for (const ending of ['unlisten', 'disconnect', 'giveUp'] as const) {
			const harness = createHeldHarness();
			harness.session?.onSegment?.('And can you.');

			if (ending === 'unlisten') {
				harness.input.unlisten('c1');
			}

			if (ending === 'disconnect') {
				harness.input.disconnect('c1');
			}

			if (ending === 'giveUp') {
				harness.session?.onError('Soniox 401', 'soniox');
			}

			await Bun.sleep(HOLD_MS + 30);
			expect(harness.utterances).toEqual([]);
		}
	});

	it('the wait survives a dropped stream: the rest said on the new stream completes it', async () => {
		const harness = createHarness({ holdMs: HOLD_MS, computeReconnectDelay: () => 1 });
		harness.input.listen('c1');
		harness.sessions[0]?.onSegment?.('Switch to—');
		harness.sessions[0]?.onFinal('');
		await waitForSettle();
		await Bun.sleep(10);
		harness.sessions[1]?.onSegment?.('checkout api main.');
		await waitForSettle();
		expect(harness.utterances).toEqual(['Switch to checkout api main.']);
	});

	it('push-to-talk is never held: the release is the end', () => {
		const harness = createHeldHarness();
		harness.input.start('c2');
		harness.input.stop('c2');
		harness.sessions.at(-1)?.onFinal('and can you');
		expect(harness.utterances).toEqual(['and can you']);
	});
});

describe('VoiceInput hands-free: a sentence cut in two', () => {
	const WAIT_MS = 30;

	const createWaitHarness = (extra: HarnessExtras = {}) => {
		const harness = createHarness({ continueMs: WAIT_MS, holdMs: 80, ...extra });
		harness.input.listen('c1');

		return harness;
	};

	it('speech that goes on inside the wait → one sentence to the kernel', async () => {
		const harness = createWaitHarness();
		harness.session?.onSegment?.('Check the conversation history for when you forward it.');
		await Bun.sleep(WAIT_MS / 2);
		harness.session?.onPartial('To a session, I want');
		await Bun.sleep(WAIT_MS);
		expect(harness.utterances).toEqual([]);
		harness.session?.onSegment?.('To a session, I want an audible confirmation.');
		await Bun.sleep(WAIT_MS + 10);
		expect(harness.utterances).toEqual([
			'Check the conversation history for when you forward it. To a session, I want an audible confirmation.',
		]);
	});

	it('"yes" and then the rest → never a bare yes', async () => {
		const harness = createWaitHarness();
		harness.session?.onSegment?.('Yes.');
		harness.session?.onSegment?.('But not the migration.');
		await Bun.sleep(WAIT_MS + 10);
		expect(harness.utterances).toEqual(['Yes. But not the migration.']);
	});

	it('"stop" inside the wait → the command is dropped and stop still goes', async () => {
		const harness = createWaitHarness();
		harness.session?.onSegment?.('Push the branch.');
		harness.session?.onSegment?.('Stop.');
		expect(harness.utterances).toEqual(['Stop.']);
		expect(harness.store.state.transcript).toBeNull();
		expect(harness.talkEnds).toEqual([1]);
		await Bun.sleep(WAIT_MS + 10);
		expect(harness.utterances).toEqual(['Stop.']);
	});

	it.each(['Hold on.', 'Wait.'])(
		'%p inside the wait → joined, so it reaches the kernel with the command',
		async (word) => {
			const harness = createWaitHarness();
			harness.session?.onSegment?.('Push the branch.');
			harness.session?.onSegment?.(word);
			await Bun.sleep(WAIT_MS + 10);
			expect(harness.utterances).toEqual([`Push the branch. ${word}`]);
		},
	);

	it('two quick commands without punctuation → still two sentences', async () => {
		const harness = createWaitHarness();
		harness.session?.onSegment?.('go home');
		harness.session?.onSegment?.('open store front');
		await Bun.sleep(WAIT_MS + 10);
		expect(harness.utterances).toEqual(['go home. open store front']);
	});

	it('Voice OS heard back during the wait → it neither stretches nor joins', async () => {
		const harness = createWaitHarness({
			listSpokenLines: () => [{ text: 'Checking the logs, back shortly.', endedAt: null }],
		});
		harness.session?.onSegment?.('Run the tests.');
		harness.session?.onPartial('checking the logs back');
		await Bun.sleep(WAIT_MS + 10);
		expect(harness.utterances).toEqual(['Run the tests.']);
	});

	it('a finished command that background talk turns into an unfinished one → still capped', async () => {
		const harness = createWaitHarness({ maxWaitMs: 60 });
		harness.session?.onSegment?.('Go home.');
		harness.session?.onSegment?.('so I was saying that the');

		for (let i = 0; i < 8; i++) {
			await Bun.sleep(15);
			harness.session?.onPartial(`and then the recipe ${i}`);
		}

		expect(harness.utterances).toEqual(['Go home. so I was saying that the']);
	});

	it('an unfinished start is not capped: it waits for the rest as it always has', async () => {
		const harness = createWaitHarness({ maxWaitMs: 20 });
		harness.session?.onSegment?.('Switch to—');
		await Bun.sleep(40);
		harness.session?.onSegment?.('checkout api main.');
		await Bun.sleep(WAIT_MS + 10);
		expect(harness.utterances).toEqual(['Switch to checkout api main.']);
	});

	it('a breath or an "mm" in the wait neither stretches it nor labels it', async () => {
		const harness = createWaitHarness();
		harness.session?.onSegment?.('Run the tests.');
		harness.session?.onPartial('Mm.');
		expect(harness.store.state.transcript?.target).not.toBe('waiting for the rest…');
		await Bun.sleep(WAIT_MS + 10);
		expect(harness.utterances).toEqual(['Run the tests.']);
	});

	it('background talk that never stops → the command still goes at the cap', async () => {
		const harness = createWaitHarness({ maxWaitMs: 60 });
		harness.session?.onSegment?.('Run the tests.');

		for (let i = 0; i < 8; i++) {
			await Bun.sleep(15);
			harness.session?.onPartial(`and so the recipe needs ${i} cups`);
		}

		expect(harness.utterances).toEqual(['Run the tests.']);
	});

	it('hands-free off, or another tab taking over, inside the wait → the command still goes', () => {
		const off = createWaitHarness();
		off.session?.onSegment?.('Run the tests.');
		off.input.unlisten('c1');
		expect(off.utterances).toEqual(['Run the tests.']);

		const moved = createWaitHarness();
		moved.session?.onSegment?.('Run the tests.');
		moved.input.listen('c2');
		expect(moved.utterances).toEqual(['Run the tests.']);
	});

	it("the stream's last words, then hands-free gives up → those words still go", () => {
		const harness = createWaitHarness({ computeReconnectDelay: () => null });
		harness.session?.onFinal('Run the tests.');
		expect(harness.utterances).toEqual(['Run the tests.']);
	});

	it('a turn cut off mid-thought is still dropped when listening ends, as before', () => {
		const harness = createWaitHarness();
		harness.session?.onSegment?.('Switch to—');
		harness.input.unlisten('c1');
		expect(harness.utterances).toEqual([]);
	});

	it('push-to-talk never waits', () => {
		const harness = createHarness({ continueMs: 1000 });
		harness.input.start('c1');
		harness.input.stop('c1');
		harness.session?.onFinal('Run the tests.');
		expect(harness.utterances).toEqual(['Run the tests.']);
	});
});

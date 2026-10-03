import { MAX_WAIT_MS } from './listener.js';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeWav } from './wav.js';
import { Store } from '../state/store.js';
import type { SttSessionOptions } from './stt.js';
import { MAX_PRESS_MS, VoiceInput, type VoiceInputOptions } from './voice-in.js';
import { computeReconnectDelay } from './listener.js';
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
	| 'awakeMs'
	| 'awakeCapMs'
>;

interface CreateHarnessParams extends HarnessExtras {
	apiKey?: string | null;
	debugAudioDir?: string | null;
	maxPressMs?: number;
	maxDictationMs?: number;
}

const createHarness = ({
	apiKey = 'k',
	debugAudioDir = null,
	maxPressMs,
	maxDictationMs,
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
	const dictated: boolean[] = [];
	const startedAts: number[] = [];
	const talkStarts: number[] = [];
	const talkEnds: number[] = [];
	let session: SttSessionOptions | null = null;
	const sessions: SttSessionOptions[] = [];
	const sent: number[] = [];
	let ends = 0;
	const cancelled: number[] = [];
	const kept: { text: string; client: string }[] = [];
	const listenOffs: { client: string; reason: string }[] = [];
	const listenStates: boolean[] = [];
	let ignored = 0;
	const input = new VoiceInput({
		continueMs: CONTINUE_MS,
		...extra,
		onListenOff: (client, reason) => listenOffs.push({ client, reason }),
		onListenState: (_client, isAwake) => listenStates.push(isAwake),
		onHeardIgnored: () => {
			ignored += 1;
		},
		store,
		apiKey,
		onUtterance: (text, _client, startedAt, { isDictated }) => {
			utterances.push(text);
			dictated.push(isDictated);
			startedAts.push(startedAt);
		},
		onKept: (text, client) => kept.push({ text, client }),
		onTalkStart: () => talkStarts.push(1),
		onTalkEnd: () => talkEnds.push(1),
		debugAudioDir,
		maxPressMs,
		maxDictationMs,
		createSession: (options) => {
			session = options;
			const index = sessions.push(options) - 1;

			return {
				send: (chunk) => sent.push(chunk.byteLength),
				end: async () => {
					ends += 1;
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
		dictated,
		startedAts,
		talkStarts,
		talkEnds,
		sent,
		sessions,
		cancelled,
		kept,
		listenOffs,
		listenStates,
		get ignored() {
			return ignored;
		},
		get session() {
			return session;
		},
		get ended() {
			return ends > 0;
		},
		get ends() {
			return ends;
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

	it('a press that heard nothing leaves no start behind; a press begun before the last is routed keeps its own', () => {
		let clock = 1000;
		const harness = createHarness({ now: () => clock });
		harness.input.start('c1');
		harness.input.stop('c1');
		harness.session?.onFinal('   ');
		clock = 9000;
		harness.input.start('c1');
		const first = harness.session;
		harness.input.stop('c1');
		clock = 9500;
		harness.input.start('c1');
		const second = harness.session;
		second?.onFinal('and the linter');
		first?.onFinal('run the tests');

		expect(harness.utterances).toEqual(['run the tests', 'and the linter']);
		expect(harness.startedAts).toEqual([9000, 9500]);
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

	it('voice off → every tab and Discord let go: listens and presses cancelled, a dictation sent, nothing listens after', () => {
		const harness = createHarness();
		harness.input.listen('c1');
		harness.input.listen('discord', 48000, 'on-demand');
		harness.input.start('c2');
		harness.input.start('c3', 16000, { isDictation: true });

		harness.input.disconnectAll('voice off');

		expect(harness.input.isListening()).toBe(false);
		// Both listens and the press cancelled; the dictation (index 3) finishes instead.
		expect([...harness.cancelled].sort()).toEqual([0, 1, 2]);
		harness.sessions[3]?.onFinal('what I had so far');
		expect(harness.utterances).toEqual(['what I had so far']);
		// Audio after it goes nowhere: no stream is fed or opened.
		harness.input.pushAudio('c1', new Uint8Array(4));
		harness.input.pushAudio('c2', new Uint8Array(4));
		expect(harness.sent).toEqual([]);
		expect(harness.sessions).toHaveLength(4);
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

	it('the press cap is two minutes', () => expect(MAX_PRESS_MS).toBe(2 * 60_000));

	// Debug note 30: a long press lost everything said in it. A press never released is not a turn,
	// but what it heard is kept for the developer to send.
	it("a press held past the cap → its stream ended, its words kept as a draft, nothing routed; the tab's next press is routed", async () => {
		const harness = createHarness({ maxPressMs: 20 });
		harness.input.start('c1');
		expect(harness.ended).toBe(false);
		await Bun.sleep(40);
		expect(harness.ended).toBe(true);
		expect(harness.cancelled).toEqual([]);
		harness.sessions[0]?.onFinal('a long thought said in one go');
		expect(harness.kept).toEqual([{ text: 'a long thought said in one go', client: 'c1' }]);
		expect(harness.utterances).toEqual([]);
		expect(harness.store.state.spoken.at(-1)?.text).toBe(
			'Not sent — what you said is in the text box.',
		);

		harness.input.start('c1');
		harness.input.stop('c1');
		harness.sessions[1]?.onFinal('go home');
		expect(harness.utterances).toEqual(['go home']);
		expect(harness.kept).toHaveLength(1);
	});

	it("a capped press that heard nothing → nothing kept, nothing routed; the tab's next press is routed", async () => {
		const harness = createHarness({ maxPressMs: 20 });
		harness.input.start('c1');
		await Bun.sleep(40);
		harness.sessions[0]?.onFinal('   ');
		expect(harness.kept).toEqual([]);
		expect(harness.utterances).toEqual([]);

		harness.input.start('c1');
		harness.input.stop('c1');
		harness.sessions[1]?.onFinal('go home');
		expect(harness.utterances).toEqual(['go home']);
	});

	it('released after the cap → handled once: no second end, the words kept once', async () => {
		const harness = createHarness({ maxPressMs: 20 });
		harness.input.start('c1');
		await Bun.sleep(40);
		harness.input.stop('c1');
		harness.sessions[0]?.onFinal('x');
		expect(harness.ends).toBe(1);
		expect(harness.kept).toEqual([{ text: 'x', client: 'c1' }]);
		expect(harness.utterances).toEqual([]);
	});

	it("a new press while one is stuck → the stuck one's words kept as a draft, the new one routed", () => {
		const harness = createHarness();
		harness.input.start('c1');
		const [stuck] = harness.sessions;
		harness.input.start('c1');
		const fresh = harness.sessions[1];
		expect(harness.ended).toBe(true);
		expect(harness.cancelled).toEqual([]);

		harness.input.stop('c1');
		fresh?.onFinal('run the tests');
		expect(harness.utterances).toEqual([]);
		stuck?.onFinal('the room talking for a minute');
		expect(harness.kept).toEqual([{ text: 'the room talking for a minute', client: 'c1' }]);
		expect(harness.utterances).toEqual(['run the tests']);
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
		expect(harness.store.state.spoken.at(-1)?.text).toBe('Listening stopped: Soniox 401: bad key');
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
			{ client: 'c1', reason: 'listening moved to another tab' },
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

	it('speech that became no turn leaves no start behind for the next one', async () => {
		let clock = 1000;
		const harness = createHeldHarness({ now: () => clock, quietMs: 5 });
		harness.session?.onPartial('um so, like');
		await Bun.sleep(20);
		clock = 6000;
		harness.session?.onPartial('open checkout');
		harness.session?.onSegment?.('open checkout.');
		await waitForSettle();

		expect(harness.utterances).toEqual(['open checkout.']);
		expect(harness.startedAts).toEqual([6000]);
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

	it("the cap is a two-minute backstop, not a limit on the developer's turn", () =>
		expect(MAX_WAIT_MS).toBe(120_000));

	it('a developer who keeps talking long past the old cap → one request, sent at their pause', async () => {
		// The default cap, and a clock that moves 1 s per word burst: 12 s of talking, past the old 8 s.
		let clock = 0;
		const harness = createWaitHarness({ now: () => clock });
		harness.session?.onSegment?.('Add to debug that it feels like turns get committed twice.');

		for (let i = 0; i < 12; i++) {
			await Bun.sleep(15);
			clock += 1_000;
			harness.session?.onPartial(`because right now I just started ${i}`);
		}

		harness.session?.onSegment?.('because right now I just started to say something.');
		await Bun.sleep(WAIT_MS + 20);

		expect(harness.utterances).toEqual([
			'Add to debug that it feels like turns get committed twice. because right now I just started to say something.',
		]);
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

describe('simulated speech (debug)', () => {
	it('shows the words as heard, then routes them like a spoken turn, with no stream opened', async () => {
		const harness = createHarness();

		harness.input.simulate('tab', 'run the tests', 5);

		expect(harness.store.state.transcript?.text).toBe('run the tests');
		expect(harness.talkStarts).toHaveLength(1);
		expect(harness.utterances).toEqual([]);

		await Bun.sleep(15);

		expect(harness.utterances).toEqual(['run the tests']);
		expect(harness.store.state.transcript).toBeNull();
		expect(harness.talkEnds).toHaveLength(1);
		expect(harness.sessions).toHaveLength(0);
	});
});

describe('VoiceInput on demand', () => {
	const onDemand = (extra: CreateHarnessParams = {}) => {
		const harness = createHarness(extra);
		harness.input.listen('c1', 16000, 'on-demand');

		return harness;
	};

	it('talk around the developer without "Voice OS" → left alone: no barge-in, no transcript, nothing sent', async () => {
		const harness = onDemand();
		harness.session?.onPartial('Tonight on the evening news, heavy rain');
		harness.session?.onSegment?.('Tonight on the evening news, heavy rain is expected.');
		await waitForSettle();

		expect(harness.talkStarts).toEqual([]);
		expect(harness.store.state.transcript).toBeNull();
		expect(harness.utterances).toEqual([]);
		expect(harness.ignored).toBe(1);
		expect(harness.input.listenModeOf('c1')).toBe('on-demand');
	});

	it('"Voice OS, …" → the call opens, the command is routed without the name, and it waits for its name again', async () => {
		const harness = onDemand();
		harness.session?.onPartial('Voice OS, tell checkout');
		expect(harness.talkStarts).toEqual([1]);
		expect(harness.store.state.transcript?.text).toBe('tell checkout');
		harness.session?.onSegment?.('Voice OS, tell checkout to run the tests.');
		await waitForSettle();

		expect(harness.utterances).toEqual(['tell checkout to run the tests.']);
		// false at listen start, true on the call, false once the turn went.
		expect(harness.listenStates).toEqual([false, true, false]);

		harness.session?.onSegment?.('And the weather tomorrow is sunny.');
		await waitForSettle();
		expect(harness.utterances).toHaveLength(1);
	});

	it('"Voice OS, stop." → a one-word command still goes', async () => {
		const harness = onDemand();
		harness.session?.onSegment?.('Voice OS, stop.');
		await waitForSettle();

		expect(harness.utterances).toEqual(['stop.']);
	});

	it('"Voice OS." on its own, a pause, then the command → one turn', async () => {
		const harness = onDemand({ awakeMs: 200 });
		harness.session?.onSegment?.('Voice OS.');
		// Well past the settle wait: nothing is sent for the name alone, and the call stays open.
		await Bun.sleep(30);
		expect(harness.utterances).toEqual([]);
		harness.session?.onSegment?.('Tell checkout to run the tests.');
		await waitForSettle();

		expect(harness.utterances).toEqual(['Tell checkout to run the tests.']);
		expect(harness.listenStates).toEqual([false, true, false]);
	});

	it('the name split across segments ("Voice" | "OS, open the doc") is a call too', async () => {
		const harness = onDemand();
		harness.session?.onPartial('Voice OS, open');
		harness.session?.onSegment?.('Voice');
		harness.session?.onSegment?.('OS, open the doc.');
		await waitForSettle();

		expect(harness.utterances).toEqual(['open the doc.']);
	});

	it('woken by a partial, the final segment rewritten without the name → still the turn', async () => {
		const harness = onDemand();
		harness.session?.onPartial('Voice OS, what is');
		harness.session?.onSegment?.('Boys, what is running?');
		await waitForSettle();

		expect(harness.utterances).toEqual(['Boys, what is running?']);
	});

	it('Voice OS saying its own name, heard back → no call', async () => {
		const harness = onDemand({
			listSpokenLines: () => [
				{ text: 'store front main is done. Voice OS is ready.', endedAt: null },
			],
			now: () => 1000,
		});
		harness.session?.onSegment?.('Voice OS is ready.');
		await waitForSettle();

		expect(harness.utterances).toEqual([]);
		expect(harness.listenStates).toEqual([false]);
	});

	it('called and then silent → it goes back to waiting for its name, speech may play', async () => {
		const harness = onDemand({ awakeMs: 20 });
		harness.session?.onSegment?.('Voice OS.');
		await Bun.sleep(40);

		expect(harness.listenStates).toEqual([false, true, false]);
		expect(harness.talkEnds).toEqual([1]);
		harness.session?.onSegment?.('Heavy rain is expected.');
		await waitForSettle();
		expect(harness.utterances).toEqual([]);
	});

	it('called, and still talking at the cap → what was held and what is being said go together', async () => {
		const harness = onDemand({ awakeCapMs: 30, continueMs: 1_000, holdMs: 1_000 });
		harness.session?.onSegment?.('Voice OS, push the branch and');
		harness.session?.onPartial('the tag, please');
		await Bun.sleep(60);

		expect(harness.utterances).toEqual(['push the branch and the tag, please']);
		expect(harness.listenStates.at(-1)).toBe(false);
		expect(harness.talkEnds).toEqual([1]);

		// The rest of that sentence, finalized after the cap, is not a second turn.
		harness.session?.onSegment?.('the tag, please.');
		await waitForSettle();
		expect(harness.utterances).toHaveLength(1);
	});

	it('a command said in one breath past the cap → sent, not lost', async () => {
		const harness = onDemand({ awakeCapMs: 30 });
		harness.session?.onPartial('Voice OS, tell checkout to run the whole');
		await Bun.sleep(60);

		expect(harness.utterances).toEqual(['tell checkout to run the whole']);

		// The words that keep coming, then the segment speech-to-text finishes, name and all, are
		// those words again: sent once, and no second call opens.
		harness.session?.onPartial('Voice OS, tell checkout to run the whole test');
		harness.session?.onSegment?.('Voice OS, tell checkout to run the whole test suite.');
		expect(harness.listenStates).toEqual([false, true, false]);
		expect(harness.talkStarts).toEqual([1]);
		await waitForSettle();
		expect(harness.utterances).toHaveLength(1);
		expect(harness.listenStates.at(-1)).toBe(false);

		// The next call works as usual.
		harness.session?.onSegment?.('Voice OS, stop.');
		await waitForSettle();
		expect(harness.utterances).toEqual(['tell checkout to run the whole', 'stop.']);
	});

	it("called, then 'voice os' later in a sentence → kept as the developer's words", async () => {
		const harness = onDemand();
		harness.session?.onSegment?.('Voice OS.');
		harness.session?.onSegment?.('Check the voice OS logs.');
		await waitForSettle();

		expect(harness.utterances).toEqual(['Check the voice OS logs.']);
	});

	it('a finished sentence ends the call at once: talk straight after it is not joined', async () => {
		const harness = onDemand({ continueMs: 1_000 });
		harness.session?.onSegment?.('Voice OS, tell checkout to run the tests.');
		expect(harness.utterances).toEqual(['tell checkout to run the tests.']);
		harness.session?.onSegment?.('Tonight on the evening news, heavy rain is expected.');
		await Bun.sleep(20);

		expect(harness.utterances).toHaveLength(1);
	});

	it('an unfinished sentence still waits for the rest', async () => {
		const harness = onDemand({ holdMs: 200 });
		harness.session?.onSegment?.('Voice OS, tell checkout to');
		expect(harness.utterances).toEqual([]);
		harness.session?.onSegment?.('run the tests.');
		await waitForSettle();

		expect(harness.utterances).toEqual(['tell checkout to run the tests.']);
	});

	it('"end of turn" → sent at once, without waiting for the pause, the phrase taken out', () => {
		const harness = onDemand({ continueMs: 1_000 });
		harness.session?.onSegment?.('Voice OS, run the tests, end of turn.');

		expect(harness.utterances).toEqual(['run the tests']);
	});

	it('listening stops while called → the call closes', () => {
		const harness = onDemand();
		harness.session?.onSegment?.('Voice OS.');
		harness.input.unlisten('c1');

		expect(harness.listenStates).toEqual([false, true, false]);
	});

	it('the stream drops while called → the call closes; with words held, it waits on the new stream', async () => {
		const idle = onDemand({ computeReconnectDelay: () => 0 });
		idle.session?.onSegment?.('Voice OS.');
		idle.session?.onError('dropped', 'connection');
		expect(idle.listenStates).toEqual([false, true, false]);

		const held = onDemand({ computeReconnectDelay: () => 0, holdMs: 200, continueMs: 200 });
		held.session?.onSegment?.('Voice OS, tell checkout to');
		held.session?.onError('dropped', 'connection');
		await Bun.sleep(5);
		held.session?.onSegment?.('run the tests.');
		await Bun.sleep(260);
		expect(held.utterances).toEqual(['tell checkout to run the tests.']);
	});

	it('hands-free is unchanged: every turn goes, and "end of turn" sends at once there too', () => {
		const harness = createHarness({ continueMs: 1_000 });
		harness.input.listen('c1', 16000, 'hands-free');
		harness.session?.onSegment?.('Open the doc, end of turn');

		expect(harness.utterances).toEqual(['Open the doc']);
		expect(harness.listenStates).toEqual([]);
		expect(harness.input.listenModeOf('c1')).toBe('hands-free');
		expect(harness.input.listenModeOf('c2')).toBe('push');
	});

	describe('dictation', () => {
		const dictate = (harness: ReturnType<typeof createHarness>, client = 'c1') =>
			harness.input.start(client, undefined, { isDictation: true });

		it('sent → routed as dictated, once its final arrives', () => {
			const harness = createHarness();
			dictate(harness);
			harness.input.stop('c1');
			harness.sessions[0]?.onFinal('so the thing about the retries is');
			expect(harness.utterances).toEqual(['so the thing about the retries is']);
			expect(harness.dictated).toEqual([true]);
		});

		it('a plain press is not dictated', () => {
			const harness = createHarness();
			harness.input.start('c1');
			harness.input.stop('c1');
			harness.sessions[0]?.onFinal('run the tests');
			expect(harness.dictated).toEqual([false]);
		});

		it('reaches its cap → ended and sent, never dropped or kept', async () => {
			const harness = createHarness({ maxPressMs: 10, maxDictationMs: 20 });
			dictate(harness);
			await Bun.sleep(40);
			expect(harness.cancelled).toEqual([]);
			expect(harness.ended).toBe(true);
			harness.sessions[0]?.onFinal('a long brain dump');
			expect(harness.utterances).toEqual(['a long brain dump']);
		});

		it('discarded → the stream cancelled, nothing routed; the next press works', () => {
			const harness = createHarness();
			dictate(harness);
			harness.session?.onPartial('never mind all of this');
			harness.input.cancel('c1');
			expect(harness.cancelled).toEqual([0]);
			expect(harness.store.state.transcript).toBeNull();
			harness.sessions[0]?.onFinal('never mind all of this');

			harness.input.start('c1');
			harness.input.stop('c1');
			harness.sessions[1]?.onFinal('run the tests');
			expect(harness.utterances).toEqual(['run the tests']);
		});

		it('discard with nothing under way → nothing happens', () => {
			const harness = createHarness();
			harness.input.cancel('c1');
			expect(harness.cancelled).toEqual([]);
		});

		it('a new press while dictating → the dictation is sent first, then the press', () => {
			const harness = createHarness();
			dictate(harness);
			harness.input.start('c1');
			expect(harness.cancelled).toEqual([]);
			harness.input.stop('c1');
			harness.sessions[1]?.onFinal('stop');
			harness.sessions[0]?.onFinal('the whole dump');
			expect(harness.utterances).toEqual(['the whole dump', 'stop']);
			expect(harness.dictated).toEqual([true, false]);
		});

		it('the tab goes away mid-dictation, or after Send → its words are still sent', () => {
			const live = createHarness();
			dictate(live);
			live.input.disconnect('c1');
			expect(live.cancelled).toEqual([]);
			live.sessions[0]?.onFinal('what I had so far');
			expect(live.utterances).toEqual(['what I had so far']);

			const sent = createHarness();
			dictate(sent);
			sent.input.stop('c1');
			sent.input.disconnect('c1');
			sent.sessions[0]?.onFinal('all of it');
			expect(sent.utterances).toEqual(['all of it']);
		});

		it('listening turned on while dictating → the dictation is sent, not starved', () => {
			const harness = createHarness();
			dictate(harness);
			harness.input.listen('c1', 16000, 'hands-free');
			expect(harness.cancelled).toEqual([]);
			harness.sessions[0]?.onFinal('before listening');
			expect(harness.utterances).toEqual(['before listening']);
		});
	});
});

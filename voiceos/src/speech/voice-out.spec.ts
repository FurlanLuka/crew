import { afterEach, describe, expect, it, jest } from 'bun:test';
import type { SpeechMessage } from '../shared/protocol.js';
import { Store } from '../state/store.js';
import type { SynthesizeParams } from './tts.js';
import { REMINDER_MS, VoiceOut } from './voice-out.js';

type PendingClip = SynthesizeParams & { finish: () => void; fail: (error: Error) => void };

interface CreateHarnessParams {
	delivered?: boolean;
	tab?: string | null;
}

const createHarness = ({ delivered = true, tab = 'tab-a' }: CreateHarnessParams = {}) => {
	const store = new Store();
	store.dispatch({
		type: 'worktrees',
		worktrees: [
			{ ref: 'store/main', label: 'store/main', branch: '', cwd: '/w', dirs: [], isPinned: false },
		],
	});
	const sent: { tab: string; message: SpeechMessage }[] = [];
	const clips: PendingClip[] = [];
	let now = 0;
	let speaker = tab;
	const voiceOut = new VoiceOut({
		store,
		// Synthesis stays open until the test streams chunks and finishes it, like a Soniox stream.
		synthesize: (params) =>
			new Promise<void>((resolve, reject) => {
				clips.push({ ...params, finish: resolve, fail: reject });
			}),
		play: (targetTab, message) => {
			sent.push({ tab: targetTab, message });

			return delivered;
		},
		speaker: () => speaker,
		now: () => now,
	});
	const listSynthesized = () => clips.map((clip) => clip.text);
	const getLastClip = () => clips.at(-1) as PendingClip;
	const streamChunk = (bytes = 480) => getLastClip().onAudio(new Uint8Array(bytes));
	const listSentKinds = () =>
		sent.map(
			({ tab: targetTab, message }) =>
				`${targetTab}:${message.type === 'audio' ? (message.isLast ? 'end' : 'chunk') : 'cancel'}:${message.id}`,
		);

	return {
		store,
		voiceOut,
		sent,
		clips,
		listSynthesized,
		getLastClip,
		streamChunk,
		listSentKinds,
		tick: (ms: number) => {
			now += ms;
		},
		setSpeaker: (nextSpeaker: string | null) => {
			speaker = nextSpeaker;
		},
	};
};

const flush = async () => {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve();
	}
};

afterEach(() => jest.useRealTimers());

describe('VoiceOut', () => {
	it('one clip at a time; the next waits for the browser to finish', async () => {
		const harness = createHarness();
		harness.voiceOut.say({ text: 'first', priority: 'normal' });
		harness.voiceOut.say({ text: 'second', priority: 'normal' });
		await flush();
		expect(harness.listSynthesized()).toEqual(['first']);

		harness.voiceOut.clipDone(harness.clips[0]?.id ?? '');
		await flush();
		expect(harness.listSynthesized()).toEqual(['first', 'second']);
	});

	it('every spoken line is recorded in state for all tabs', async () => {
		const harness = createHarness();
		harness.voiceOut.say({
			text: 'store/main finished the tests.',
			priority: 'normal',
			ref: 'store/main',
		});
		await flush();
		expect(harness.store.state.spoken.at(-1)).toMatchObject({
			text: 'store/main finished the tests.',
			ref: 'store/main',
		});
		expect(harness.store.state.spoken.at(-1)).not.toHaveProperty('isAsking');
		harness.voiceOut.clipDone(harness.clips[0]?.id ?? '');
		harness.voiceOut.say({
			text: 'store/main asks: push it?',
			priority: 'normal',
			ref: 'store/main',
			isAsking: true,
		});
		await flush();
		expect(harness.store.state.spoken.at(-1)).toMatchObject({ ref: 'store/main', isAsking: true });
	});

	it('spoken line keeps who said it → a kernel reply is not logged as narration', async () => {
		const harness = createHarness();
		harness.voiceOut.say({
			text: 'Nothing is waiting on you.',
			priority: 'high',
			source: 'kernel',
		});
		await flush();
		expect(harness.store.state.spoken.at(-1)).toMatchObject({
			text: 'Nothing is waiting on you.',
			source: 'kernel',
		});
	});

	it('alert cuts off what is playing', async () => {
		const harness = createHarness();
		harness.voiceOut.say({ text: 'long update', priority: 'normal' });
		await flush();
		harness.voiceOut.say({ text: 'store/main wants to push. Allow?', priority: 'alert' });
		await flush();
		expect(harness.listSynthesized().at(-1)).toBe('store/main wants to push. Allow?');
	});

	it('no speaker tab → line still shown, nothing synthesized, queue keeps moving', async () => {
		const harness = createHarness({ tab: null });
		harness.voiceOut.say({ text: 'a', priority: 'normal' });
		harness.voiceOut.say({ text: 'b', priority: 'normal' });
		await flush();
		await flush();
		expect(harness.store.state.spoken.map((line) => line.text)).toEqual(['a', 'b']);
		expect(harness.listSynthesized()).toEqual([]);
	});

	it('talking → chatter dropped, the current clip stops', async () => {
		const harness = createHarness();
		harness.voiceOut.say({ text: 'now', priority: 'normal' });
		await flush();
		harness.voiceOut.say({ text: 'later', priority: 'low' });
		harness.voiceOut.talkStarted();
		harness.voiceOut.clipDone(harness.clips[0]?.id ?? '');
		await flush();
		expect(harness.listSynthesized()).toEqual(['now']);
	});

	it('reminder: a session still waiting after 5 minutes is nudged once per interval', async () => {
		const harness = createHarness();
		harness.store.dispatch({
			type: 'narration',
			ref: 'store/main',
			needsUser: true,
			text: 'Push it?',
			topic: null,
		});
		harness.voiceOut.remind(harness.store.state);
		await flush();
		expect(harness.listSynthesized()).toEqual([]);

		harness.tick(REMINDER_MS + 1);
		harness.voiceOut.remind(harness.store.state);
		await flush();
		expect(harness.listSynthesized()).toEqual(['store/main is still waiting on you.']);
		expect(harness.store.state.spoken.at(-1)).toMatchObject({ ref: 'store/main', isAsking: true });

		harness.voiceOut.clipDone(harness.clips[0]?.id ?? '');
		harness.voiceOut.remind(harness.store.state);
		await flush();
		expect(harness.listSynthesized()).toHaveLength(1);
	});

	it('stream → each chunk goes out as it arrives, then the end marker', async () => {
		const harness = createHarness();
		harness.voiceOut.say({ text: 'hello', priority: 'normal' });
		await flush();
		harness.streamChunk();
		harness.streamChunk();
		expect(harness.listSentKinds()).toEqual([
			`tab-a:chunk:${harness.getLastClip().id}`,
			`tab-a:chunk:${harness.getLastClip().id}`,
		]);
		harness.getLastClip().finish();
		await flush();
		expect(harness.listSentKinds().at(-1)).toBe(`tab-a:end:${harness.getLastClip().id}`);
	});

	it('speaker changes mid-clip → the rest of the clip still goes to the tab it started in', async () => {
		const harness = createHarness();
		harness.voiceOut.say({ text: 'hello', priority: 'normal' });
		await flush();
		harness.streamChunk();
		harness.setSpeaker('tab-b');
		harness.streamChunk();
		harness.getLastClip().finish();
		await flush();
		expect(new Set(harness.sent.map((entry) => entry.tab))).toEqual(new Set(['tab-a']));
	});

	it('alert mid-clip → the stream is aborted, the tab told to drop it, the alert streams next', async () => {
		const harness = createHarness();
		harness.voiceOut.say({ text: 'long update', priority: 'normal' });
		await flush();
		const first = harness.getLastClip();
		harness.streamChunk();
		harness.voiceOut.say({ text: 'store/main wants to push. Allow?', priority: 'alert' });
		await flush();
		expect(first.signal.aborted).toBe(true);
		expect(harness.listSentKinds()).toContain(`tab-a:cancel:${first.id}`);
		expect(harness.listSynthesized().at(-1)).toBe('store/main wants to push. Allow?');
	});

	it('push-to-talk mid-clip → aborted and cancelled, nothing starts', async () => {
		const harness = createHarness();
		harness.voiceOut.say({ text: 'now', priority: 'normal' });
		await flush();
		harness.voiceOut.talkStarted();
		await flush();
		expect(harness.getLastClip().signal.aborted).toBe(true);
		expect(harness.listSentKinds().at(-1)).toBe(`tab-a:cancel:${harness.getLastClip().id}`);
		expect(harness.listSynthesized()).toEqual(['now']);
	});

	it('late chunks of a cut clip are not forwarded', async () => {
		const harness = createHarness();
		harness.voiceOut.say({ text: 'now', priority: 'normal' });
		await flush();
		const cut = harness.getLastClip();
		harness.voiceOut.talkStarted();
		const before = harness.sent.length;
		cut.onAudio(new Uint8Array(480));
		cut.finish();
		await flush();
		expect(harness.sent.length).toBe(before);
	});

	it('stream fails mid-clip → the tab drops it and the queue moves on', async () => {
		const harness = createHarness();
		harness.voiceOut.say({ text: 'a', priority: 'normal' });
		harness.voiceOut.say({ text: 'b', priority: 'normal' });
		await flush();
		const first = harness.getLastClip();
		harness.streamChunk();
		first.fail(new Error('Soniox TTS socket closed'));
		await flush();
		expect(harness.listSentKinds()).toContain(`tab-a:cancel:${first.id}`);
		expect(harness.listSynthesized()).toEqual(['a', 'b']);
	});

	it('tab gone mid-clip → the stream is aborted and the queue moves on', async () => {
		const harness = createHarness({ delivered: false });
		harness.voiceOut.say({ text: 'a', priority: 'normal' });
		harness.voiceOut.say({ text: 'b', priority: 'normal' });
		await flush();
		const first = harness.getLastClip();
		harness.streamChunk();
		await flush();
		expect(first.signal.aborted).toBe(true);
		expect(harness.listSynthesized()).toEqual(['a', 'b']);
	});

	it('audio_done for a stale id → ignored', async () => {
		const harness = createHarness();
		harness.voiceOut.say({ text: 'a', priority: 'normal' });
		harness.voiceOut.say({ text: 'b', priority: 'normal' });
		await flush();
		harness.voiceOut.clipDone('s-unknown');
		await flush();
		expect(harness.listSynthesized()).toEqual(['a']);
	});

	it('talk starts after every chunk was sent, while the tab still plays → the tab is told to stop', async () => {
		const harness = createHarness();
		harness.voiceOut.say({ text: 'a', priority: 'normal' });
		await flush();
		harness.streamChunk();
		harness.getLastClip().finish();
		await flush();
		harness.voiceOut.talkStarted();
		expect(harness.listSentKinds().at(-1)).toBe(`tab-a:cancel:${harness.getLastClip().id}`);
	});

	it('Soniox goes silent mid-clip → cut after the gap, next clip starts', async () => {
		jest.useFakeTimers();
		const harness = createHarness();
		harness.voiceOut.say({ text: 'a', priority: 'normal' });
		harness.voiceOut.say({ text: 'b', priority: 'normal' });
		await flush();
		harness.streamChunk();
		jest.advanceTimersByTime(10_001);
		await flush();
		expect(harness.listSentKinds()).toContain(`tab-a:cancel:${harness.clips[0]?.id}`);
		expect(harness.listSynthesized()).toEqual(['a', 'b']);
	});

	it('tab never reports audio_done → queue moves on after the clip length plus a margin', async () => {
		jest.useFakeTimers();
		const harness = createHarness();
		harness.voiceOut.say({ text: 'a', priority: 'normal' });
		harness.voiceOut.say({ text: 'b', priority: 'normal' });
		await flush();
		harness.streamChunk(48_000);
		harness.getLastClip().finish();
		await flush();
		jest.advanceTimersByTime(3_900);
		await flush();
		expect(harness.listSynthesized()).toEqual(['a']);
		jest.advanceTimersByTime(200);
		await flush();
		expect(harness.listSynthesized()).toEqual(['a', 'b']);
	});

	it('a line said while a press is live → held, then played after the press ends', async () => {
		const harness = createHarness();
		harness.voiceOut.talkStarted();
		harness.voiceOut.say({ text: 'Opened checkout.', priority: 'high', source: 'kernel' });
		await flush();
		expect(harness.listSynthesized()).toEqual([]);

		harness.voiceOut.talkEnded();
		await flush();
		expect(harness.listSynthesized()).toEqual(['Opened checkout.']);
	});

	it('an alert during a press is held too — nothing is spoken into the open mic', async () => {
		const harness = createHarness();
		harness.voiceOut.talkStarted();
		harness.voiceOut.say({ text: 'store/main wants to push. Allow?', priority: 'alert' });
		await flush();
		expect(harness.listSynthesized()).toEqual([]);
		harness.voiceOut.talkEnded();
		await flush();
		expect(harness.listSynthesized()).toEqual(['store/main wants to push. Allow?']);
	});

	it('talkEnded without a press → nothing changes', async () => {
		const harness = createHarness();
		harness.voiceOut.talkEnded();
		harness.voiceOut.say({ text: 'a', priority: 'normal' });
		await flush();
		expect(harness.listSynthesized()).toEqual(['a']);
	});

	it('a named line about the session on screen → no name; about another session → its name first', async () => {
		const harness = createHarness();
		harness.store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store/main' } });
		harness.voiceOut.say({
			text: 'asks: push it?',
			priority: 'high',
			ref: 'store/main',
			isNamed: true,
		});
		await flush();
		expect(harness.listSynthesized()).toEqual(['Push it?']);
		harness.getLastClip().finish();
		await flush();
		harness.voiceOut.clipDone(harness.getLastClip().id);

		harness.store.dispatch({ type: 'switch_view', view: { kind: 'grid' } });
		harness.voiceOut.say({
			text: 'tests pass.',
			priority: 'normal',
			ref: 'store/main',
			isNamed: true,
		});
		await flush();
		expect(harness.listSynthesized().at(-1)).toBe('store, main: tests pass.');
		expect(harness.store.state.spoken.at(-1)?.text).toBe('store, main: tests pass.');
	});

	it('the name is decided when the line plays, not when it was queued', async () => {
		const harness = createHarness();
		harness.voiceOut.say({ text: 'first', priority: 'normal' });
		harness.voiceOut.say({
			text: 'tests pass.',
			priority: 'normal',
			ref: 'store/main',
			isNamed: true,
		});
		await flush();
		harness.store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store/main' } });
		harness.voiceOut.clipDone(harness.getLastClip().id);
		await flush();
		expect(harness.listSynthesized().at(-1)).toBe('Tests pass.');
	});

	it('listRecentSpeech → each line as it was said (name included), open while playing, dropped once out of the echo window', async () => {
		const harness = createHarness();
		harness.voiceOut.say({
			text: 'tests pass.',
			priority: 'normal',
			ref: 'store/main',
			isNamed: true,
		});
		await flush();
		expect(harness.voiceOut.listRecentSpeech()).toEqual([
			{ text: 'store, main: tests pass.', endedAt: null },
		]);

		harness.tick(1000);
		harness.voiceOut.clipDone(harness.getLastClip().id);
		expect(harness.voiceOut.listRecentSpeech()).toEqual([
			{ text: 'store, main: tests pass.', endedAt: 1000 },
		]);

		harness.tick(10_001);
		expect(harness.voiceOut.listRecentSpeech()).toEqual([]);
	});

	it('a cut clip counts as ended when it was cut', async () => {
		const harness = createHarness();
		harness.voiceOut.say({ text: 'a long report', priority: 'normal' });
		await flush();
		harness.tick(300);
		harness.voiceOut.talkStarted();
		expect(harness.voiceOut.listRecentSpeech()).toEqual([{ text: 'a long report', endedAt: 300 }]);
	});

	it('chime on the first chunk of an announcement only; a fresh reply plays straight away', async () => {
		const readChimes = (harness: ReturnType<typeof createHarness>) =>
			harness.sent.map(({ message }) => message.type === 'audio' && message.hasChime === true);
		const announcement = createHarness();
		announcement.voiceOut.say({ text: 'store/main finished.', priority: 'normal' });
		await flush();
		announcement.streamChunk();
		announcement.streamChunk();
		expect(readChimes(announcement)).toEqual([true, false]);

		const reply = createHarness();
		reply.voiceOut.say({ text: 'version 4.2.', priority: 'high', source: 'kernel', isReply: true });
		await flush();
		reply.streamChunk();
		expect(readChimes(reply)).toEqual([false]);
	});

	it('a reply that waited behind other speech → chimed after all', async () => {
		const harness = createHarness();
		harness.voiceOut.say({ text: 'a long report', priority: 'high' });
		harness.voiceOut.say({
			text: 'version 4.2.',
			priority: 'high',
			source: 'kernel',
			isReply: true,
		});
		await flush();
		harness.streamChunk();
		harness.getLastClip().finish();
		await flush();
		harness.tick(5000);
		harness.voiceOut.clipDone(harness.clips[0]?.id ?? '');
		await flush();
		harness.streamChunk();
		expect(harness.sent.at(-1)?.message).toMatchObject({
			type: 'audio',
			id: harness.getLastClip().id,
			hasChime: true,
		});
	});
});

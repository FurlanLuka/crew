import { afterEach, describe, expect, it, jest } from 'bun:test';
import type { SpeechMessage, View } from '../shared/protocol.js';
import { Store } from '../state/store.js';
import type { SynthesizeParams } from './tts.js';
import type { Effect } from '../state/reducer.js';
import { MAX_REMINDERS, REMINDER_MS, VoiceOut } from './voice-out.js';

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
			{ ref: 'store/wrk1', label: 'store/wrk1', branch: '', cwd: '/w1', dirs: [], isPinned: false },
		],
	});
	store.dispatch({ type: 'active_loaded', refs: ['store/main', 'store/wrk1'] });
	let hasPage = true;
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
		hasPage: () => hasPage,
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
		setHasPage: (isOpen: boolean) => {
			hasPage = isOpen;
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

	// Debug note 31: "Switching to Crew." from the switch, then again as the kernel's reply.
	describe("Voice OS's own line said again while the first is still to be heard", () => {
		const sayKernel = (harness: ReturnType<typeof createHarness>, text: string) =>
			harness.voiceOut.say({ text, priority: 'high', source: 'kernel' });

		const playAll = async (harness: ReturnType<typeof createHarness>) => {
			for (let played = 0; played < 5; played++) {
				await flush();
				harness.voiceOut.clipDone(harness.clips.at(-1)?.id ?? '');
			}

			await flush();
		};

		it('while the first plays → said once', async () => {
			const harness = createHarness();
			sayKernel(harness, 'Switching to Crew.');
			await flush();
			sayKernel(harness, 'Switching to Crew.');
			await playAll(harness);
			expect(harness.listSynthesized()).toEqual(['Switching to Crew.']);
		});

		it('while the first is still queued → said once', async () => {
			const harness = createHarness();
			harness.voiceOut.say({ text: 'Tests pass.', priority: 'high', source: 'narrator' });
			await flush();
			sayKernel(harness, 'Switching to Crew.');
			sayKernel(harness, 'Switching to Crew.');
			await playAll(harness);
			expect(harness.listSynthesized()).toEqual(['Tests pass.', 'Switching to Crew.']);
		});

		it('differing only in case, spacing or the final period → dropped', async () => {
			const harness = createHarness();
			sayKernel(harness, 'Switching to Crew.');
			sayKernel(harness, 'switching to crew ');
			sayKernel(harness, 'Switching to Crew');
			await playAll(harness);
			expect(harness.listSynthesized()).toEqual(['Switching to Crew.']);
		});

		it('the same line after the first finished → said again (two quick sends to one session)', async () => {
			const harness = createHarness();
			sayKernel(harness, 'Sent to checkout.');
			await flush();
			harness.voiceOut.clipDone(harness.clips[0]?.id ?? '');
			sayKernel(harness, 'Sent to checkout.');
			await playAll(harness);
			expect(harness.listSynthesized()).toEqual(['Sent to checkout.', 'Sent to checkout.']);
		});

		it('the first cut by the developer talking → the same line said again', async () => {
			const harness = createHarness();
			sayKernel(harness, 'Switching to Crew.');
			await flush();
			harness.voiceOut.talkStarted();
			sayKernel(harness, 'Switching to Crew.');
			harness.voiceOut.talkEnded();
			await playAll(harness);
			expect(harness.listSynthesized()).toEqual(['Switching to Crew.', 'Switching to Crew.']);
		});

		it("a narrator's line is never dropped this way", async () => {
			const harness = createHarness();
			harness.voiceOut.say({ text: 'Tests pass.', priority: 'normal', source: 'narrator' });
			harness.voiceOut.say({ text: 'Tests pass.', priority: 'normal', source: 'narrator' });
			await playAll(harness);
			expect(harness.listSynthesized()).toEqual(['Tests pass.', 'Tests pass.']);
		});
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

	it("an alert waits for the session's own line to play out, then plays next", async () => {
		const harness = createHarness();
		harness.voiceOut.say({
			text: 'I like it. Where should notes live?',
			priority: 'high',
			isOwed: true,
		});
		await flush();
		harness.voiceOut.say({ text: 'store/main asks: where should notes live?', priority: 'alert' });
		await flush();

		expect(harness.listSynthesized()).toEqual(['I like it. Where should notes live?']);
		expect(harness.listSentKinds().some((kind) => kind.includes(':cancel:'))).toBe(false);

		harness.voiceOut.clipDone(harness.clips[0]?.id ?? '');
		await flush();

		expect(harness.listSynthesized().at(-1)).toBe('store/main asks: where should notes live?');
	});

	it("dropping a session's waiting lines leaves the one playing alone", async () => {
		const harness = createHarness();
		harness.voiceOut.say({ text: 'playing', priority: 'normal', ref: 'store/main' });
		await flush();
		harness.voiceOut.say({ text: 'waiting', priority: 'normal', ref: 'store/main' });
		harness.tick(10);
		harness.voiceOut.dropQueuedAbout('store/main', 10);
		harness.voiceOut.clipDone(harness.clips[0]?.id ?? '');
		await flush();

		expect(harness.listSynthesized()).toEqual(['playing']);
		expect(harness.listSentKinds().some((kind) => kind.includes(':cancel:'))).toBe(false);
	});

	it('a line that plays out, and one cut off, are marked so in the state', async () => {
		const harness = createHarness();
		harness.voiceOut.say({ text: 'played', priority: 'normal' });
		await flush();
		harness.voiceOut.clipDone(harness.clips[0]?.id ?? '');
		await flush();
		harness.voiceOut.say({ text: 'cut', priority: 'normal' });
		await flush();
		harness.voiceOut.talkStarted();

		expect(harness.store.state.spoken.map(({ text, isCut }) => ({ text, isCut }))).toEqual([
			{ text: 'played', isCut: undefined },
			{ text: 'cut', isCut: true },
		]);
		expect(harness.store.state.spoken.every((line) => line.endedAt !== undefined)).toBe(true);
	});

	it('an update arriving when it is already quiet → every listener sees it before its play', async () => {
		const harness = createHarness();
		harness.tick(60_000);
		const seen: string[] = [];
		// Registered after VoiceOut, like the gateway: a play dispatched from inside the update reached it first.
		harness.store.subscribe((stamped) => {
			seen.push(`${stamped.seq}:${stamped.input.type}`);
		});

		harness.voiceOut.say({
			text: 'The retry backoff is done.',
			priority: 'normal',
			ref: 'store/wrk1',
			announcement: { kind: 'done', about: 'The retry backoff is done.' },
		});
		await flush();

		const types = seen.map((entry) => entry.split(':')[1]);
		const seqs = seen.map((entry) => Number(entry.split(':')[0]));
		expect(types.slice(0, 2)).toEqual(['meanwhile_added', 'play_meanwhile']);
		expect(seqs).toEqual([...seqs].sort((first, second) => first - second));
	});

	it('a session line queued on screen, played after the developer left → held, and announced if its turn is over', async () => {
		const harness = createHarness();
		harness.store.dispatch({ type: 'session_started', ref: 'store/main' });
		const long =
			'The router refactor is done, the tests pass, and the branch is pushed for review now.';
		harness.voiceOut.say({ text: 'playing now', priority: 'normal' });
		await flush();
		harness.voiceOut.say({
			text: long,
			priority: 'high',
			ref: 'store/main',
			isOwed: true,
			isHoldable: true,
		});
		harness.store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		harness.voiceOut.clipDone(harness.clips[0]?.id ?? '');
		await flush();

		expect(harness.listSynthesized()).toEqual(['playing now']);
		expect(harness.store.state.meanwhile.map((item) => [item.ref, item.kind, item.about])).toEqual([
			[
				'store/main',
				'done',
				'The router refactor is done, the tests pass, and the branch is pushed for review now',
			],
		]);
		expect(harness.store.state.sessions['store/main']?.heldLine).toMatchObject({
			kind: 'line',
			text: long,
		});

		harness.store.dispatch({
			type: 'held_line_heard',
			ref: 'store/main',
			id: harness.store.state.sessions['store/main']?.heldLine?.id ?? '',
		});
		harness.voiceOut.say({
			text: `${long} Again.`,
			priority: 'high',
			ref: 'store/main',
			isOwed: true,
			isHoldable: true,
		});
		await flush();
		harness.voiceOut.clipDone(harness.clips.at(-1)?.id ?? '');
		await flush();

		expect(harness.store.state.meanwhile.map((item) => [item.ref, item.kind, item.about])).toEqual([
			[
				'store/main',
				'done',
				'The router refactor is done, the tests pass, and the branch is pushed for review now',
			],
		]);
	});

	it('the same while its session still works → held silently: its turn end will announce it', async () => {
		const harness = createHarness();
		const long =
			'Plan approved; building the notes panel, its tests, and the page wiring right now.';
		harness.store.dispatch({ type: 'session_started', ref: 'store/main' });
		harness.store.dispatch({ type: 'send', ref: 'store/main', text: 'build the notes' });
		harness.voiceOut.say({ text: 'playing now', priority: 'normal' });
		await flush();
		harness.voiceOut.say({
			text: long,
			priority: 'high',
			ref: 'store/main',
			isOwed: true,
			isHoldable: true,
		});
		harness.voiceOut.clipDone(harness.clips[0]?.id ?? '');
		await flush();

		expect(harness.listSynthesized()).toEqual(['playing now']);
		expect(harness.store.state.sessions['store/main']?.heldLine).toMatchObject({ text: long });
	});

	it('its session stopped before it played → neither held nor announced', async () => {
		const harness = createHarness();
		harness.store.dispatch({ type: 'deactivate', ref: 'store/main' });
		const long =
			'The router refactor is done, the tests pass, and the branch is pushed for review now.';
		harness.voiceOut.say({ text: 'playing now', priority: 'normal' });
		await flush();
		harness.voiceOut.say({
			text: long,
			priority: 'high',
			ref: 'store/main',
			isOwed: true,
			isHoldable: true,
		});
		harness.store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		harness.voiceOut.clipDone(harness.clips[0]?.id ?? '');
		await flush();

		expect(harness.listSynthesized()).toEqual(['playing now']);
		expect(harness.store.state.sessions['store/main']?.heldLine).toBeNull();
	});

	it('the line of a question whose alert was said, played after the developer left → dropped: the alert told it', async () => {
		const harness = createHarness();
		const long =
			'One choice for you before I start: should the notes live in the Voice OS folder or the project?';
		harness.store.dispatch({ type: 'session_started', ref: 'store/main' });
		harness.store.dispatch({ type: 'send', ref: 'store/main', text: 'build the notes' });
		harness.voiceOut.say({ text: 'playing now', priority: 'normal' });
		await flush();
		harness.voiceOut.say({
			text: long,
			priority: 'high',
			ref: 'store/main',
			isOwed: true,
			isHoldable: true,
			isAsking: true,
		});
		harness.store.dispatch({
			type: 'ask_opened',
			ask: {
				id: 'q1',
				ref: 'store/main',
				at: 0,
				kind: 'question',
				input: {},
				questions: [
					{
						question: 'Where should notes live?',
						header: 'Notes location',
						multiSelect: false,
						options: [],
					},
				],
			},
		});
		harness.store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		harness.voiceOut.clipDone(harness.clips[0]?.id ?? '');
		await flush();

		// The alert was said (the line was never heard): it tells the question, once, and nothing is kept.
		await flush();
		harness.voiceOut.clipDone(harness.clips.at(-1)?.id ?? '');
		await flush();

		expect(harness.listSynthesized().filter((text) => text.includes('needs you'))).toEqual([]);
		// The alert itself goes through the store's effects (main.ts), which this harness does not wire.
		expect(harness.listSynthesized()).toEqual(['playing now']);
		expect(harness.store.state.sessions['store/main']?.heldLine).toBeNull();
	});

	it('held after its turn, a second line of a session already announced → no second "is done"', async () => {
		const harness = createHarness();
		harness.store.dispatch({ type: 'session_started', ref: 'store/main' });
		const first =
			'The router refactor is done, the tests pass, and the branch is pushed for review now.';
		const second =
			'Also rebased on main and resolved the two conflicts in the router config files just now.';
		harness.voiceOut.say({ text: 'playing now', priority: 'normal' });
		await flush();

		for (const text of [first, second]) {
			harness.voiceOut.say({
				text,
				priority: 'high',
				ref: 'store/main',
				isOwed: true,
				isHoldable: true,
			});
		}

		harness.store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		harness.voiceOut.clipDone(harness.clips[0]?.id ?? '');
		await flush();
		harness.voiceOut.clipDone(harness.clips.at(-1)?.id ?? '');
		await flush();

		expect(harness.listSynthesized()).toEqual(['playing now']);
		expect(harness.store.state.meanwhile.map((item) => [item.ref, item.kind, item.about])).toEqual([
			[
				'store/main',
				'done',
				'The router refactor is done, the tests pass, and the branch is pushed for review now',
			],
		]);
		expect(harness.store.state.sessions['store/main']?.heldLine).toMatchObject({
			text: second,
			isAnnounced: true,
		});
	});

	it('a short line after an announced report still unheard → held with it, not played', async () => {
		const harness = createHarness();
		harness.store.dispatch({ type: 'session_started', ref: 'store/main' });
		const report =
			'The router refactor is done, the tests pass, and the branch is pushed for review now.';
		harness.voiceOut.say({ text: 'playing now', priority: 'normal' });
		await flush();
		harness.voiceOut.say({
			text: report,
			priority: 'high',
			ref: 'store/main',
			isOwed: true,
			isHoldable: true,
		});
		harness.voiceOut.say({
			text: 'Covered in the answer above.',
			priority: 'high',
			ref: 'store/main',
			isOwed: true,
			isHoldable: true,
		});
		harness.store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		harness.voiceOut.clipDone(harness.clips[0]?.id ?? '');
		await flush();
		harness.voiceOut.clipDone(harness.clips.at(-1)?.id ?? '');
		await flush();

		expect(harness.listSynthesized()).toEqual(['playing now']);
		expect(harness.store.state.meanwhile.map((item) => [item.ref, item.kind, item.about])).toEqual([
			[
				'store/main',
				'done',
				'The router refactor is done, the tests pass, and the branch is pushed for review now',
			],
		]);
		expect(harness.store.state.sessions['store/main']?.heldLine).toMatchObject({ text: report });
	});

	it('a short question queued on screen, played after the developer opened another session → held, "needs you"', async () => {
		const harness = createHarness();
		harness.store.dispatch({
			type: 'worktrees',
			worktrees: ['store/main', 'store/wrk1'].map((ref) => ({
				ref,
				label: ref,
				branch: '',
				cwd: '/w',
				dirs: [],
				isPinned: false,
			})),
		});
		harness.store.dispatch({ type: 'session_started', ref: 'store/main' });
		harness.voiceOut.say({ text: 'playing now', priority: 'normal' });
		await flush();
		harness.voiceOut.say({
			text: 'Push it now?',
			priority: 'high',
			ref: 'store/main',
			isOwed: true,
			isHoldable: true,
			isAsking: true,
		});
		harness.store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store/wrk1' } });
		harness.voiceOut.clipDone(harness.clips[0]?.id ?? '');
		await flush();

		expect(harness.listSynthesized()).toEqual(['playing now']);
		expect(harness.store.state.meanwhile.map((item) => [item.ref, item.kind, item.about])).toEqual([
			['store/main', 'needs', null],
		]);
		expect(harness.store.state.sessions['store/main']?.heldLine).toMatchObject({
			text: 'Push it now?',
			isAnnounced: true,
		});
	});

	it('a long line held after its turn while a background sub-agent works → no "is done"', async () => {
		const harness = createHarness();
		harness.store.dispatch({ type: 'session_started', ref: 'store/main' });
		harness.store.dispatch({
			type: 'subagent_started',
			ref: 'store/main',
			taskId: 't1',
			agentType: null,
			description: 'research',
			isBackground: true,
		});
		const long =
			'Started the competitor research in the background: worktree tools, cockpits and voice control.';
		harness.voiceOut.say({ text: 'playing now', priority: 'normal' });
		await flush();
		harness.voiceOut.say({
			text: long,
			priority: 'high',
			ref: 'store/main',
			isOwed: true,
			isHoldable: true,
		});
		harness.store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		harness.voiceOut.clipDone(harness.clips[0]?.id ?? '');
		await flush();

		expect(harness.listSynthesized()).toEqual(['playing now']);
		expect(harness.store.state.sessions['store/main']?.heldLine).toMatchObject({ text: long });
	});

	it('"done" says its own last line, not the request', async () => {
		const harness = createHarness();
		harness.store.dispatch({ type: 'session_started', ref: 'store/main' });
		harness.store.dispatch({ type: 'send', ref: 'store/main', text: 'run the whole test suite' });
		harness.store.dispatch({ type: 'turn_ended', ref: 'store/main', costUsd: 0, text: '' });
		harness.store.dispatch({
			type: 'send',
			ref: 'store/main',
			text: 'push the telephony branches',
		});
		harness.store.dispatch({ type: 'turn_ended', ref: 'store/main', costUsd: 0, text: '' });
		const long =
			'The router refactor is done, the tests pass, and the branch is pushed for review now.';
		harness.voiceOut.say({ text: 'playing now', priority: 'normal' });
		await flush();
		harness.voiceOut.say({
			text: long,
			priority: 'high',
			ref: 'store/main',
			isOwed: true,
			isHoldable: true,
		});
		harness.store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
		harness.voiceOut.clipDone(harness.clips[0]?.id ?? '');
		await flush();

		expect(harness.store.state.meanwhile.map((item) => [item.ref, item.kind, item.about])).toEqual([
			[
				'store/main',
				'done',
				'The router refactor is done, the tests pass, and the branch is pushed for review now',
			],
		]);
	});

	it('a short line plays wherever the developer is', async () => {
		const harness = createHarness();
		harness.voiceOut.say({
			text: 'Tests pass.',
			priority: 'high',
			ref: 'store/main',
			isHoldable: true,
		});
		await flush();

		expect(harness.listSynthesized()).toEqual(['Tests pass.']);
	});

	it('"needs you" carries its chime to the tab, and never cuts the line playing', async () => {
		const harness = createHarness();
		harness.voiceOut.say({ text: 'long update', priority: 'normal' });
		await flush();
		harness.voiceOut.say({
			text: 'store/main needs you: notes location.',
			priority: 'high',
			ref: 'store/main',
			chime: 'needs',
		});
		await flush();

		expect(harness.listSentKinds().some((kind) => kind.includes(':cancel:'))).toBe(false);

		harness.voiceOut.clipDone(harness.clips[0]?.id ?? '');
		await flush();
		harness.streamChunk();

		expect(harness.sent.at(-1)?.message).toMatchObject({ hasChime: true, chime: 'needs' });
	});

	it('the reminder of a question only announced is not something a bare yes answers', async () => {
		const harness = createHarness();
		harness.store.dispatch({
			type: 'ask_opened',
			ask: {
				id: 'q1',
				ref: 'store/main',
				at: 0,
				kind: 'question',
				input: {},
				questions: [
					{
						question:
							'Where should notes live: the Voice OS folder or a file inside the project itself?',
						header: 'Notes location',
						multiSelect: false,
						options: [],
					},
				],
			},
		});
		harness.voiceOut.remind(harness.store.state);
		harness.tick(REMINDER_MS + 1);
		harness.voiceOut.remind(harness.store.state);
		await flush();

		const reminder = harness.store.state.spoken.find((line) =>
			line.text.includes('still needs you'),
		);

		expect(reminder?.text).toBe('store/main still needs you.');
		expect(reminder?.isAsking).toBeUndefined();
	});

	it("a setup session's ask → never reminded: it waits in Set up's chat", async () => {
		const harness = createHarness();
		harness.store.dispatch({
			type: 'worktrees',
			worktrees: [
				{
					ref: 'store/main',
					label: 'store/main',
					branch: '',
					cwd: '/w',
					dirs: [],
					isPinned: false,
				},
				{ ref: 'setup', label: 'setup', branch: '', cwd: '/h', dirs: [], isPinned: true },
			],
		});
		harness.store.dispatch({
			type: 'ask_opened',
			ask: {
				id: 'p1',
				ref: 'setup',
				at: 0,
				kind: 'permission',
				toolName: 'Bash',
				summary: 'run crew rm worktree store/wrk1',
				input: {},
				suggestions: [],
			},
		});
		harness.voiceOut.remind(harness.store.state);
		harness.tick(REMINDER_MS + 1);
		harness.voiceOut.remind(harness.store.state);
		await flush();

		expect(harness.store.state.spoken.some((line) => line.text.includes('still needs you'))).toBe(
			false,
		);
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
		});
		harness.voiceOut.remind(harness.store.state);
		await flush();
		expect(harness.listSynthesized()).toEqual([]);

		harness.tick(REMINDER_MS + 1);
		harness.voiceOut.remind(harness.store.state);
		await flush();
		expect(harness.listSynthesized()).toEqual(['store/main still needs you.']);
		expect(harness.store.state.spoken.at(-1)).toMatchObject({ ref: 'store/main', isAsking: true });

		harness.voiceOut.clipDone(harness.clips[0]?.id ?? '');
		harness.voiceOut.remind(harness.store.state);
		await flush();
		expect(harness.listSynthesized()).toHaveLength(1);
	});

	it('reminder of a session deactivated while it waited → never said', async () => {
		const harness = createHarness();
		harness.store.dispatch({
			type: 'narration',
			ref: 'store/main',
			needsUser: true,
			text: 'Push it?',
		});
		harness.voiceOut.remind(harness.store.state);
		harness.store.dispatch({ type: 'deactivate', ref: 'store/main' });
		harness.tick(REMINDER_MS + 1);
		harness.voiceOut.remind(harness.store.state);
		await flush();

		expect(harness.listSynthesized()).toEqual([]);
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

		harness.store.dispatch({ type: 'switch_view', view: { kind: 'active' } });
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

describe('VoiceOut, a click away from the session whose line plays', () => {
	const LONG =
		'The router refactor is done, the tests pass, and the branch is pushed for review now.';

	interface PlayParams {
		source?: 'narrator' | 'kernel' | 'alert';
		isAsking?: boolean;
	}

	const playOnScreen = async ({ source = 'narrator', isAsking = false }: PlayParams = {}) => {
		const harness = createHarness();
		const effects: Effect[] = [];
		harness.store.onEffect((effect) => {
			effects.push(effect);
		});
		harness.store.dispatch({ type: 'session_started', ref: 'store/main' });
		harness.store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store/main' } });
		harness.voiceOut.say({
			text: LONG,
			priority: 'high',
			ref: 'store/main',
			source,
			isNamed: true,
			isOwed: true,
			isHoldable: true,
			isAsking,
		});
		await flush();

		return { ...harness, effects };
	};

	const leaveFor = async (harness: Awaited<ReturnType<typeof playOnScreen>>, view: View) => {
		harness.store.dispatch({ type: 'switch_view', view });
		await flush();
	};

	it('to another session → the line is cut and held; back there → replayed', async () => {
		const harness = await playOnScreen();
		await leaveFor(harness, { kind: 'session', ref: 'store/wrk1' });

		expect(harness.listSentKinds().at(-1)).toBe(`tab-a:cancel:${harness.clips[0]?.id}`);
		expect(harness.store.state.spoken.at(-1)).toMatchObject({ ref: 'store/main', isCut: true });
		expect(harness.store.state.sessions['store/main']?.heldLine).toMatchObject({
			kind: 'line',
			text: LONG,
		});

		harness.store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store/main' } });

		expect(harness.effects.at(-1)).toMatchObject({ type: 'speak', text: LONG, ref: 'store/main' });
		expect(harness.store.state.sessions['store/main']?.heldLine).toBeNull();
	});

	it('to another session, its own session stopped meanwhile → the line is cut and not held', async () => {
		const harness = await playOnScreen();
		harness.store.dispatch({ type: 'deactivate', ref: 'store/main' });
		await leaveFor(harness, { kind: 'session', ref: 'store/wrk1' });

		expect(harness.listSentKinds().at(-1)).toBe(`tab-a:cancel:${harness.clips[0]?.id}`);
		expect(harness.store.state.sessions['store/main']?.heldLine).toBeNull();
	});

	it('the switch alone, before its dispatch returns → nothing cut yet: the page sees the switch first', async () => {
		const harness = await playOnScreen();
		harness.store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store/wrk1' } });

		expect(harness.listSentKinds().some((kind) => kind.includes('cancel'))).toBe(false);

		await flush();

		expect(harness.store.state.sessions['store/main']?.heldLine).toMatchObject({ text: LONG });
	});

	it('to Mission Control → it plays on: lines are said there', async () => {
		for (const view of [{ kind: 'active' }, { kind: 'active' }] satisfies View[]) {
			const harness = await playOnScreen();
			await leaveFor(harness, view);

			expect(harness.listSentKinds().some((kind) => kind.includes('cancel'))).toBe(false);
			expect(harness.store.state.sessions['store/main']?.heldLine).toBeNull();
		}
	});

	it('a Voice OS line, an alert, or a line that asks → it plays on', async () => {
		for (const params of [
			{ source: 'kernel' },
			{ source: 'alert' },
			{ isAsking: true },
		] satisfies PlayParams[]) {
			const harness = await playOnScreen(params);
			await leaveFor(harness, { kind: 'session', ref: 'store/wrk1' });

			expect(harness.listSentKinds().some((kind) => kind.includes('cancel'))).toBe(false);
			expect(harness.store.state.sessions['store/main']?.heldLine).toBeNull();
		}
	});
});

describe('VoiceOut reminders', () => {
	const openQuestion = (harness: ReturnType<typeof createHarness>, id: string) =>
		harness.store.dispatch({
			type: 'ask_opened',
			ask: {
				id,
				ref: 'store/main',
				at: 0,
				kind: 'question',
				input: {},
				questions: [{ question: 'Postgres or SQLite?', multiSelect: false, options: [] }],
			},
		});

	const remindAfterInterval = async (
		harness: ReturnType<typeof createHarness>,
		state = harness.store.state,
	) => {
		harness.tick(REMINDER_MS + 1);
		harness.voiceOut.remind(state);
		await flush();

		for (const clip of harness.clips) {
			harness.voiceOut.clipDone(clip.id);
		}
	};

	const countReminders = (harness: ReturnType<typeof createHarness>) =>
		harness.listSynthesized().filter((text) => text.includes('still needs you')).length;

	it(`one ask left waiting → reminded ${MAX_REMINDERS} times, then no more`, async () => {
		const harness = createHarness();
		openQuestion(harness, 'q1');
		harness.voiceOut.remind(harness.store.state);

		for (let tick = 0; tick < MAX_REMINDERS + 3; tick++) {
			await remindAfterInterval(harness);
		}

		expect(countReminders(harness)).toBe(MAX_REMINDERS);
	});

	it('a new ask → its own reminders', async () => {
		const harness = createHarness();
		openQuestion(harness, 'q1');
		harness.voiceOut.remind(harness.store.state);

		for (let tick = 0; tick < MAX_REMINDERS + 1; tick++) {
			await remindAfterInterval(harness);
		}

		harness.store.dispatch({ type: 'ask_closed', askId: 'q1' });
		openQuestion(harness, 'q2');
		await remindAfterInterval(harness);

		expect(countReminders(harness)).toBe(MAX_REMINDERS + 1);
	});

	// A line that asked with no ask behind it waits through needsUser: keyed by when it asked.
	const waitingOnLine = (harness: ReturnType<typeof createHarness>, at: number) => {
		const { state } = harness.store;
		const session = state.sessions['store/main']!;

		return {
			...state,
			sessions: {
				...state.sessions,
				'store/main': { ...session, needsUser: { text: 'Postgres or SQLite?', at } },
			},
		};
	};

	it(`a line left waiting with no ask → reminded ${MAX_REMINDERS} times; it asks again → one more`, async () => {
		const harness = createHarness();
		const asked = waitingOnLine(harness, 1);
		harness.voiceOut.remind(asked);

		for (let tick = 0; tick < MAX_REMINDERS + 2; tick++) {
			await remindAfterInterval(harness, asked);
		}

		expect(countReminders(harness)).toBe(MAX_REMINDERS);

		await remindAfterInterval(harness, waitingOnLine(harness, 2));

		expect(countReminders(harness)).toBe(MAX_REMINDERS + 1);
	});

	it('no page open → nothing said and nothing counted; a page opens → reminded', async () => {
		const harness = createHarness();
		openQuestion(harness, 'q1');
		harness.voiceOut.remind(harness.store.state);
		harness.setHasPage(false);

		for (let tick = 0; tick < MAX_REMINDERS + 2; tick++) {
			await remindAfterInterval(harness);
		}

		expect(countReminders(harness)).toBe(0);

		harness.setHasPage(true);

		for (let tick = 0; tick < MAX_REMINDERS + 1; tick++) {
			await remindAfterInterval(harness);
		}

		expect(countReminders(harness)).toBe(MAX_REMINDERS);
	});
});

describe('VoiceOut, voice tags', () => {
	const TAGGED =
		'The flaky test was a stale lockfile all along. [relieved] Every suite passes now, pushed.';
	const PLAIN = 'The flaky test was a stale lockfile all along. Every suite passes now, pushed.';

	it('a long line → its tag reaches the voice; state.spoken and echo read the words', async () => {
		const harness = createHarness();
		harness.voiceOut.say({ text: TAGGED, priority: 'high', ref: 'store/main' });
		await flush();

		expect(harness.listSynthesized()).toEqual([TAGGED]);
		expect(harness.store.state.spoken.at(-1)).toMatchObject({ text: PLAIN });
		expect(harness.voiceOut.listRecentSpeech()).toEqual([{ text: PLAIN, endedAt: null }]);
	});

	it('a short line with a tag → still short, and its tag is not sent', async () => {
		const harness = createHarness();
		harness.voiceOut.say({ text: 'Ha, fair. [laughs] Pushing it.', priority: 'high' });
		await flush();

		expect(harness.listSynthesized()).toEqual(['Ha, fair. Pushing it.']);
	});

	it('held off screen → the held line has no tag', async () => {
		const harness = createHarness();
		harness.store.dispatch({ type: 'session_started', ref: 'store/main' });
		harness.store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store/wrk1' } });
		harness.voiceOut.say({
			text: TAGGED,
			priority: 'high',
			ref: 'store/main',
			isHoldable: true,
			source: 'narrator',
		});
		await flush();

		expect(harness.listSynthesized()).toEqual([]);
		expect(harness.store.state.meanwhile.map((item) => [item.ref, item.kind, item.about])).toEqual([
			[
				'store/main',
				'done',
				'The flaky test was a stale lockfile all along. Every suite passes now, pushed',
			],
		]);
		expect(harness.store.state.sessions['store/main']?.heldLine).toMatchObject({ text: PLAIN });
	});

	it('cut and held as the view leaves → the held line has no tag', async () => {
		const harness = createHarness();
		harness.store.dispatch({ type: 'session_started', ref: 'store/main' });
		harness.store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store/main' } });
		harness.voiceOut.say({
			text: TAGGED,
			priority: 'high',
			ref: 'store/main',
			source: 'narrator',
			isHoldable: true,
		});
		await flush();
		harness.store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: 'store/wrk1' } });
		await flush();

		expect(harness.store.state.sessions['store/main']?.heldLine).toMatchObject({ text: PLAIN });
	});
});

describe('a line that says an ask', () => {
	const openAsk = (harness: ReturnType<typeof createHarness>, id: string) =>
		harness.store.dispatch({
			type: 'ask_opened',
			ask: {
				id,
				ref: 'store/main',
				at: 0,
				kind: 'permission',
				toolName: 'Bash',
				summary: 'run git push',
				input: { command: 'git push' },
				suggestions: [],
			},
		});
	const sayAsk = (harness: ReturnType<typeof createHarness>, askId: string, text: string) =>
		harness.voiceOut.say({
			text,
			priority: 'high',
			source: 'alert',
			ref: 'store/main',
			isAsking: true,
			askId,
		});

	it('answered on the page while it plays → cut at once, and the next line plays', async () => {
		const harness = createHarness();
		openAsk(harness, 'a1');
		sayAsk(harness, 'a1', 'store/main asks: push it? Answer it, or say "options".');
		harness.voiceOut.say({ text: 'Tests pass.', priority: 'normal' });
		await flush();
		harness.streamChunk();
		const askClip = harness.getLastClip().id;

		harness.store.dispatch({ type: 'ask_closed', askId: 'a1' });
		await flush();

		expect(harness.listSentKinds()).toContain(`tab-a:cancel:${askClip}`);
		expect(harness.listSynthesized()).toEqual([
			'store/main asks: push it? Answer it, or say "options".',
			'Tests pass.',
		]);
	});

	it('answered before its turn to play → never said', async () => {
		const harness = createHarness();
		openAsk(harness, 'a1');
		harness.voiceOut.say({ text: 'Tests pass.', priority: 'normal' });
		sayAsk(harness, 'a1', 'store/main asks: push it?');
		await flush();

		harness.store.dispatch({ type: 'ask_closed', askId: 'a1' });
		await flush();
		harness.voiceOut.clipDone(harness.clips[0]?.id ?? '');
		await flush();

		expect(harness.listSynthesized()).toEqual(['Tests pass.']);
	});

	it('one of its two questions answered on the page → the line reading it is cut', async () => {
		const harness = createHarness();
		harness.store.dispatch({
			type: 'ask_opened',
			ask: {
				id: 'q1',
				ref: 'store/main',
				at: 0,
				kind: 'question',
				input: {},
				questions: [
					{ question: 'Which table?', multiSelect: false, options: [] },
					{ question: 'Which index?', multiSelect: false, options: [] },
				],
			},
		});
		harness.voiceOut.say({
			text: 'store/main asks 2 questions. First: Which table?',
			priority: 'high',
			source: 'alert',
			ref: 'store/main',
			isAsking: true,
			askId: 'q1',
			askQuestion: 0,
		});
		await flush();
		harness.streamChunk();
		const firstClip = harness.getLastClip().id;

		harness.store.dispatch({
			type: 'answer_question',
			askId: 'q1',
			answers: { 'Which table?': 'orders' },
		});
		await flush();

		expect(harness.store.state.asks).toHaveLength(1);
		expect(harness.listSentKinds()).toContain(`tab-a:cancel:${firstClip}`);
	});

	it('its reminder queued behind a line, the ask answered on the page → the reminder is never said', async () => {
		const harness = createHarness();
		openAsk(harness, 'a1');
		harness.voiceOut.remind(harness.store.state);
		harness.tick(REMINDER_MS + 1);
		harness.voiceOut.say({ text: 'Tests pass.', priority: 'high' });
		await flush();

		harness.voiceOut.remind(harness.store.state);
		harness.store.dispatch({ type: 'ask_closed', askId: 'a1' });
		await flush();
		harness.voiceOut.clipDone(harness.clips[0]?.id ?? '');
		await flush();

		expect(harness.listSynthesized()).toEqual(['Tests pass.']);
	});

	it('another ask closing → the line for the one still open plays on', async () => {
		const harness = createHarness();
		openAsk(harness, 'a1');
		openAsk(harness, 'a2');
		sayAsk(harness, 'a1', 'store/main asks: push it?');
		await flush();
		harness.streamChunk();

		harness.store.dispatch({ type: 'ask_closed', askId: 'a2' });
		await flush();

		expect(harness.listSentKinds().some((kind) => kind.includes(':cancel:'))).toBe(false);
	});
});

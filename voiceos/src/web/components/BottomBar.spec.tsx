import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PendingAsk, Session, State } from '../../shared/protocol.js';
import { createInitialState, createSession } from '../../state/reducer.js';
import type { VoiceInput } from '../use-voice-input.js';
import { BottomBar } from './BottomBar.js';

const voice: VoiceInput = {
	listenMode: 'push',
	chooseMode: () => undefined,
	micStatus: 'idle',
	isDictating: false,
	dictationStartedAt: null,
	isDiscardArmed: false,
	handleTalkStart: async () => undefined,
	handleTalkStop: () => undefined,
	handleDiscard: () => undefined,
};

const render = (state: State, input: VoiceInput = voice): string =>
	renderToStaticMarkup(
		<BottomBar
			state={state}
			voice={input}
			isAwake={false}
			isIgnored={false}
			keptDictation={null}
			send={() => undefined}
		/>,
	);

const DISCORD = {
	isConnected: true,
	isHearing: true,
	isOwnerIn: true,
	channelName: 'Voice OS',
	mode: 'on-demand',
} as const;

const onDiscord: State = {
	...createInitialState(),
	discord: DISCORD,
	transcript: { text: 'what is checkout doing', isFinal: false, target: null },
};

const STORE = 'store-front/main';

describe('BottomBar', () => {
	it('docked: the mic, the field with where the words go, and the listening mode by name', () => {
		const html = render(createInitialState());

		expect(html).toContain('aria-label="Hold to talk"');
		expect(html).toContain('→ Voice OS');
		expect(html).toContain('Push to talk');
		expect(html).toContain('aria-label="Listening mode"');
	});

	it('voice off → "voice" struck where the mic was, the way back on; no mode menu; typing says so', () => {
		const html = render({ ...createInitialState(), voiceOff: true });

		expect(html).toContain('aria-label="Turn voice on"');
		expect(html).toContain('vo-voice off');
		expect(html).not.toContain('aria-label="Hold to talk"');
		expect(html).not.toContain('aria-label="Listening mode"');
		expect(html).toContain('placeholder="Voice is off · type a command"');
	});

	it('voice off in the Discord voice channel → still the way back on, no Discord badge', () => {
		const html = render({ ...onDiscord, voiceOff: true });

		expect(html).toContain('aria-label="Turn voice on"');
		expect(html).not.toContain('aria-label="Voice via Discord"');
	});

	it('in the voice channel → a Discord badge, not a mic to press; what is heard in the box', () => {
		const html = render(onDiscord);

		expect(html).toContain('aria-label="Voice via Discord"');
		expect(html).not.toContain('aria-label="Hold to talk"');
		expect(html).toContain('what is checkout doing');
	});

	it('connected but not in the channel → the page mic as always', () => {
		const html = render({ ...onDiscord, discord: { ...DISCORD, isOwnerIn: false } });

		expect(html).toContain('aria-label="Hold to talk"');
		expect(html).not.toContain('Voice via Discord');
		expect(html).not.toContain('what is checkout doing');
	});

	it('in the channel but not hearing → said on the badge and in the box, with how to retry', () => {
		const html = render({
			...onDiscord,
			transcript: null,
			discord: { ...DISCORD, isHearing: false },
		});

		expect(html).toContain('aria-label="Voice via Discord, not hearing"');
		expect(html).toContain('pick a mode to try again');
	});

	it('the last spoken line → a caption over the box: a waveform, "Voice OS", the line', () => {
		const html = render({
			...createInitialState(),
			spoken: [{ id: 's1', text: 'Store front is ready.', source: 'kernel', at: Date.now() }],
		});

		expect(html).toContain('wave-icon');
		expect(html).toContain(
			'<span class="who">Voice OS</span><p class="said">Store front is ready.</p>',
		);
		expect(html.indexOf('Store front is ready.')).toBeLessThan(html.indexOf('vo-composer'));
	});

	it('voice off → the line without the waveform: nothing was played', () =>
		expect(
			render({
				...createInitialState(),
				voiceOff: true,
				spoken: [{ id: 's1', text: 'Store front is ready.', source: 'kernel', at: Date.now() }],
			}),
		).not.toContain('wave-icon'));

	it('a line older than a minute → no caption', () =>
		expect(
			render({
				...createInitialState(),
				spoken: [
					{ id: 's1', text: 'Store front is ready.', source: 'kernel', at: Date.now() - 61_000 },
				],
			}),
		).not.toContain('Store front is ready.'));

	describe('the queue of the session on screen', () => {
		const withQueue = (patch: Partial<Session> = {}, active: string[] = [STORE]): State => ({
			...createInitialState(),
			view: { kind: 'session', ref: STORE },
			active,
			order: [STORE],
			sessions: {
				[STORE]: {
					...createSession({
						ref: STORE,
						label: STORE,
						branch: 'b',
						cwd: '/w',
						dirs: [],
						isPinned: false,
					}),
					status: 'running',
					queue: [
						{ id: 'q1', text: 'also update the changelog', at: 1 },
						{
							id: 'q2',
							text: 'heads up',
							at: 2,
							from: { ref: 'checkout-api/main', label: 'checkout' },
						},
					],
					...patch,
				},
			},
		});

		it('folded into the box as "2 queued", saying one came from another session; no list above it', () => {
			const html = render(withQueue());

			expect(html).toContain('aria-label="2 queued, from checkout"');
			expect(html).toContain('<b class="qchip-n">2</b> queued');
			expect(html.indexOf('qchip')).toBeGreaterThan(html.indexOf('vo-composer'));
			expect(html).not.toContain('aria-label="queued"');
			expect(html).not.toContain('also update the changelog');
		});

		it('only your own words queued → no mark from another session', () => {
			const html = render(
				withQueue({ queue: [{ id: 'q1', text: 'also update the changelog', at: 1 }] }),
			);

			expect(html).toContain('aria-label="1 queued"');
			expect(html).not.toContain('dot run');
		});

		it('an inactive session → its queue still shows, beside Activate', () => {
			const html = render(withQueue({}, []));

			expect(html).toContain('isn&#x27;t active');
			expect(html).toContain('aria-label="2 queued, from checkout"');
		});

		it('nothing queued → no chip', () =>
			expect(render(withQueue({ queue: [] }))).not.toContain('qchip'));
	});

	describe('the ask of the session on screen', () => {
		const question: PendingAsk = {
			id: 'q1',
			ref: 'store-front/main',
			at: 1,
			kind: 'question',
			input: {},
			questions: [
				{
					question: 'A new events table, or a column on orders?',
					multiSelect: false,
					options: [{ label: 'A new events table' }, { label: 'A column on orders' }],
				},
			],
		};

		it('docked first in the bar, above the spoken line and the mic, with an X to decline it', () => {
			const html = render({
				...createInitialState(),
				view: { kind: 'session', ref: 'store-front/main' },
				asks: [question],
			});

			expect(html.indexOf('aria-label="question"')).toBeGreaterThan(-1);
			expect(html.indexOf('aria-label="question"')).toBeLessThan(html.indexOf('vo-composer'));
			expect(html).toContain('A column on orders');
			expect(html).toContain('aria-label="Decline the question"');
		});

		it('docked on screen → the box still says it answers, without the alarm: the sheet is the alarm', () => {
			const html = render({
				...createInitialState(),
				view: { kind: 'session', ref: 'store-front/main' },
				asks: [question],
			});

			expect(html).toContain('answering store-front/main');
			expect(html).not.toContain('alarm');
		});

		it('off its screen (Home) → the box answers it, in red: nothing docked says so', () => {
			const html = render({ ...createInitialState(), view: { kind: 'active' }, asks: [question] });

			expect(html).not.toContain('aria-label="question"');
			expect(html).toContain('vo-route route alarm');
		});

		it('a blocked call and a question together → the blocked one first, both above the box', () => {
			const html = render({
				...createInitialState(),
				view: { kind: 'session', ref: 'store-front/main' },
				asks: [question],
				denials: [
					{
						id: 'd1',
						ref: 'store-front/main',
						toolName: 'Bash',
						summary: 'run rm -rf dist',
						at: 1,
					},
				],
			});

			expect(html.indexOf('aria-label="denied"')).toBeGreaterThan(-1);
			expect(html.indexOf('aria-label="denied"')).toBeLessThan(
				html.indexOf('aria-label="question"'),
			);
			expect(html.indexOf('aria-label="question"')).toBeLessThan(html.indexOf('vo-composer'));
		});

		it("another session's ask stays on its own screen", () =>
			expect(
				render({
					...createInitialState(),
					view: { kind: 'session', ref: 'checkout-api/main' },
					asks: [question],
				}),
			).not.toContain('aria-label="question"'));
	});
});

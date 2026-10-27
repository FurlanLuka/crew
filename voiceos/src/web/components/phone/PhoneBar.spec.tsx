import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { State } from '../../../shared/protocol.js';
import { createInitialState, createSession } from '../../../state/reducer.js';
import type { InputMode } from '../../listen-mode.js';
import type { VoiceInput } from '../../use-voice-input.js';
import { describePhoneHint, PhoneBar } from './PhoneBar.js';

const STORE = 'store-front/main';

const voiceIn = (listenMode: InputMode, extra: Partial<VoiceInput> = {}): VoiceInput => ({
	listenMode,
	chooseMode: () => undefined,
	micStatus: 'idle',
	isDictating: false,
	dictationStartedAt: null,
	isDiscardArmed: false,
	handleTalkStart: async () => undefined,
	handleTalkStop: () => undefined,
	handleDiscard: () => undefined,
	...extra,
});

const onSession = (): State => {
	const state = createInitialState();

	return {
		...state,
		sessions: {
			[STORE]: createSession({
				ref: STORE,
				label: STORE,
				branch: 'b',
				cwd: '/w',
				dirs: [],
				isPinned: false,
			}),
		},
		active: [STORE],
		order: [STORE],
		view: { kind: 'session', ref: STORE },
	};
};

const render = (voice: VoiceInput, state: State = onSession()): string =>
	renderToStaticMarkup(
		<PhoneBar
			state={state}
			voice={voice}
			isAwake={false}
			keptDictation={null}
			send={() => undefined}
		/>,
	);

const hearing = (state: State, text: string): State => ({
	...state,
	transcript: { text, isFinal: false, target: null },
});

describe('PhoneBar', () => {
	it('push to talk: the mode on the left, a hint in the middle, the hold mic on the right', () => {
		const html = render(voiceIn('push'));

		expect(html).toContain('aria-label="Listening mode"');
		expect(html).toContain('Hold the mic to talk');
		expect(html).toContain('aria-label="Hold to talk"');
		expect(html).not.toContain('<textarea');
		expect(html).not.toContain('class="mbar hot');
	});

	it('push to talk, holding: the bar fills with what it hears and lights up', () => {
		const html = render(
			voiceIn('push', { micStatus: 'live' }),
			hearing(onSession(), 'Also make the search ignore accents'),
		);

		expect(html).toContain('Also make the search ignore accents');
		expect(html).toContain(' hot');
		expect(html).toContain('talk-btn live');
	});

	it('dictation: a mic to start it, then send', () => {
		expect(render(voiceIn('dictation'))).toContain('aria-label="Start dictating"');

		const html = render(voiceIn('dictation', { isDictating: true, micStatus: 'live' }));

		expect(html).toContain('aria-label="Send the dictation"');
		expect(html).toContain(' tall');
	});

	it.each<InputMode>(['hands-free', 'on-demand'])('%s: nothing to press on the right', (mode) => {
		const html = render(voiceIn(mode, { micStatus: 'live' }));

		expect(html).not.toContain('talk-btn');
		expect(html).not.toContain('send-btn');
		expect(html).not.toContain('<textarea');
	});

	it('text only: a real message box named after the session, and send', () => {
		const html = render(voiceIn('text'));

		expect(html).toContain('placeholder="Message store-front/main"');
		expect(html).toContain('aria-label="Send"');
		expect(html).not.toContain('Hold to talk');
	});

	it('voice off: a message box whatever the mode', () => {
		const html = render(voiceIn('push'), { ...onSession(), voiceOff: true });

		expect(html).toContain('placeholder="Voice is off · type a message"');
	});

	it('no attachments, no route chip, no spoken line', () => {
		const html = render(voiceIn('text'));

		expect(html).not.toContain('att-clip');
		expect(html).not.toContain('vo-route');
		expect(html).not.toContain('vo-spoken');
	});

	it('a refused mic: what to do, above the bar', () => {
		const html = render(voiceIn('push', { micStatus: 'denied' }));

		expect(html).toContain('class="phone-note mic-help" role="alert"');
		expect(html).toContain('then hold the mic again');
		expect(render(voiceIn('text', { micStatus: 'denied' }))).not.toContain('mic-help');
	});

	it('an inactive session on screen: only the way to activate it', () => {
		const html = render(voiceIn('push'), { ...onSession(), active: [] });

		expect(html).toContain('isn&#x27;t active');
		expect(html).toContain('Activate');
	});
});

describe('describePhoneHint', () => {
	const hint = (mode: InputMode, extra: Partial<Parameters<typeof describePhoneHint>[0]> = {}) =>
		describePhoneHint({ mode, micStatus: 'idle', isAwake: false, isDictating: false, ...extra });

	it('says what to do in each mode', () => {
		expect(hint('push')).toBe('Hold the mic to talk');
		expect(hint('dictation')).toBe('Tap the mic to dictate');
		expect(hint('dictation', { isDictating: true })).toBe('Dictating: take your time');
		expect(hint('hands-free')).toBe('Listening: just talk');
		expect(hint('on-demand')).toContain('Voice OS');
		expect(hint('on-demand', { isAwake: true })).toBe('Listening to you');
	});

	it('a blocked mic says so, except in text only', () => {
		expect(hint('push', { micStatus: 'denied' })).toBe('Microphone blocked');
		expect(hint('text', { micStatus: 'denied' })).toBe('Type a message');
	});
});

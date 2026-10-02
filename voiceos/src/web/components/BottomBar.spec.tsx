import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { State } from '../../shared/protocol.js';
import { createInitialState } from '../../state/reducer.js';
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

describe('BottomBar', () => {
	it('docked: the mic, the field with where the words go, and the listening mode by name', () => {
		const html = render(createInitialState());

		expect(html).toContain('aria-label="Hold to talk"');
		expect(html).toContain('→ Voice OS');
		expect(html).toContain('Push to talk');
		expect(html).toContain('aria-label="Listening mode"');
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

	it('the last spoken line sits above the composer', () => {
		const html = render({
			...createInitialState(),
			spoken: [{ id: 's1', text: 'Store front is ready.', source: 'kernel', at: Date.now() }],
		});

		expect(html).toContain('Spoken');
		expect(html).toContain('Store front is ready.');
	});
});

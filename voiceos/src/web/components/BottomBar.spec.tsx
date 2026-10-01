import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { State } from '../../shared/protocol.js';
import { createInitialState } from '../../state/reducer.js';
import { PcmPlayer } from '../use-speech-player.js';
import { BottomBar } from './BottomBar.js';

const render = (state: State): string =>
	renderToStaticMarkup(
		<BottomBar
			state={state}
			isConnected
			listenCommand={null}
			isAwake={false}
			ignoredAt={0}
			keptDictation={null}
			send={() => {}}
			sendBinary={() => {}}
			player={new PcmPlayer()}
			micStatus="idle"
			onMicStatusChange={() => {}}
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
});

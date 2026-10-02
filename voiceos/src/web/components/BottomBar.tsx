// The voice bar, docked across the bottom: a moment Voice OS asks, the last spoken line, then the
// mic, where your words go and the listening mode. The mic's logic is use-voice-input.ts.
import type { ClientMessage, State } from '../../shared/protocol.js';
import { isListeningMode, type InputMode } from '../listen-mode.js';
import type { ListeningMode } from '../../shared/protocol.js';
import type { KeptDictation } from '../use-connection.js';
import type { VoiceInput } from '../use-voice-input.js';
import { Composer } from './Composer.js';
import { LastSpokenLine } from './LastSpokenLine.js';
import { ModeMenu } from './ModeMenu.js';
import { MomentsRow } from './MomentsRow.js';
import { QueueList } from './QueueList.js';

interface BottomBarProps {
	state: State;
	voice: VoiceInput;
	// On demand: "Voice OS" was heard; isIgnored: speech without it was just left alone.
	isAwake: boolean;
	isIgnored: boolean;
	keptDictation: KeptDictation | null;
	send: (message: ClientMessage) => void;
}

export const MIC_TITLES: Record<InputMode, string> = {
	push: 'Hold Space or this button to talk',
	'on-demand':
		'On demand: always listening, but only what follows “Voice OS” is taken; say “end of turn” to send at once',
	'hands-free': 'Hands-free: always listening, speak over Voice OS to interrupt it',
	dictation: 'Dictation: click to start, click again or Send when done',
};

const DISCORD_MODES: InputMode[] = ['on-demand', 'hands-free'];

const DISCORD_TITLES: Record<ListeningMode, string> = {
	'on-demand': 'Voice via Discord, on demand: only what follows “Voice OS” is taken',
	'hands-free': 'Voice via Discord, hands-free: every turn is acted on',
};

const MicIcon = () => (
	<svg
		width="16"
		height="16"
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.5"
		aria-hidden="true"
	>
		<rect x="6" y="2" width="4" height="8" rx="2" />
		<path d="M3.5 8a4.5 4.5 0 0 0 9 0M8 12.5V14" />
	</svg>
);

export const BottomBar = ({
	state,
	voice,
	isAwake,
	isIgnored,
	keptDictation,
	send,
}: BottomBarProps) => {
	const { listenMode, micStatus, isDictating } = voice;
	// In the Discord voice channel, Discord is the mic: this page shows what is heard and takes typing.
	const discord = state.discord?.isOwnerIn ? state.discord : null;
	const isDictationMode = listenMode === 'dictation';
	const isListening = isListeningMode(listenMode) && micStatus === 'live';
	const discordTitle = discord
		? discord.isHearing
			? DISCORD_TITLES[discord.mode]
			: 'Voice via Discord, but not hearing you: pick a mode to try again'
		: '';
	const viewed = state.view.kind === 'session' ? state.sessions[state.view.ref] : undefined;

	return (
		<footer className="vo-bar">
			<MomentsRow state={state} dispatch={(action) => send({ type: 'action', action })} />
			{viewed && (
				<QueueList session={viewed} dispatch={(action) => send({ type: 'action', action })} />
			)}
			<LastSpokenLine state={state} />
			<div className="vo-composer">
				{discord ? (
					<span
						className={`vo-mic discord ${discord.isHearing ? '' : 'off'}`}
						role="img"
						aria-label={discord.isHearing ? 'Voice via Discord' : 'Voice via Discord, not hearing'}
						title={discordTitle}
					>
						Discord
					</span>
				) : (
					<button
						type="button"
						className={`vo-mic mic ${micStatus === 'live' ? 'live' : ''} ${micStatus === 'denied' ? 'off' : ''} ${
							isDictating ? 'dictating' : ''
						}`}
						aria-label={
							isDictationMode
								? isDictating
									? 'Send the dictation'
									: 'Start dictating'
								: listenMode === 'push'
									? 'Hold to talk'
									: isAwake
										? 'Listening to you'
										: 'Listening'
						}
						title={MIC_TITLES[listenMode]}
						onClick={
							isDictationMode
								? () =>
										isDictating
											? voice.handleTalkStop()
											: void voice.handleTalkStart({ isDictation: true })
								: undefined
						}
						onPointerDown={isDictationMode ? undefined : () => void voice.handleTalkStart()}
						onPointerUp={isDictationMode ? undefined : voice.handleTalkStop}
						onPointerLeave={isDictationMode ? undefined : voice.handleTalkStop}
					>
						{micStatus === 'live' ? (
							<span className="wave live" aria-hidden="true">
								<i style={{ animationDelay: '0s' }} />
								<i style={{ animationDelay: '.1s' }} />
								<i style={{ animationDelay: '.2s' }} />
							</span>
						) : (
							<MicIcon />
						)}
					</button>
				)}
				<Composer
					state={state}
					voice={voice}
					isAwake={isAwake}
					isOnDiscord={discord !== null}
					keptDictation={keptDictation}
					send={send}
				/>
				{!discord && (
					<ModeMenu
						mode={listenMode}
						onChoose={voice.chooseMode}
						isOn={isListening}
						isAwake={isAwake}
						isIgnored={isIgnored}
						isDenied={micStatus === 'denied'}
						title={MIC_TITLES[listenMode]}
						languages={state.languages}
						onLanguages={(languages) =>
							send({ type: 'action', action: { type: 'set_languages', languages } })
						}
					/>
				)}
				{discord && (
					<ModeMenu
						mode={discord.mode}
						modes={DISCORD_MODES}
						onChoose={(mode: InputMode) =>
							isListeningMode(mode) && send({ type: 'discord_listen', mode })
						}
						isOn={discord.isHearing}
						isAwake={false}
						isIgnored={false}
						isDenied={!discord.isHearing}
						title={discordTitle}
						languages={state.languages}
						onLanguages={(languages) =>
							send({ type: 'action', action: { type: 'set_languages', languages } })
						}
					/>
				)}
			</div>
		</footer>
	);
};

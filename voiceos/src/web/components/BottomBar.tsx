import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
	type ClientMessage,
	isListenMode,
	type ListenMode,
	type State,
} from '../../shared/protocol.js';
import { describeRouteChip } from '../../shared/route-chip.js';
import { describeVoiceGate } from '../voice-gate-chip.js';
import { Mic, isMicAllowed } from '../audio.js';
import { PRE_ROLL_MS } from '../ptt.js';
import { describeListening } from '../listen-mode.js';
import type { ListenCommand, MicStatus } from '../types.js';
import { useListenMode } from '../use-listen-mode.js';
import type { PcmPlayer } from '../use-speech-player.js';

interface BottomBarProps {
	state: State;
	isConnected: boolean;
	listenCommand: ListenCommand | null;
	// On demand: "Voice OS" was heard; ignoredAt: when speech without it was last left alone.
	isAwake: boolean;
	ignoredAt: number;
	send: (message: ClientMessage) => void;
	sendBinary: (chunk: ArrayBuffer) => void;
	player: PcmPlayer;
	micStatus: MicStatus;
	onMicStatusChange: (micStatus: MicStatus) => void;
}

const IGNORED_DOT_MS = 900;

const MIC_TITLES: Record<ListenMode, string> = {
	push: 'Hold Space or this button to talk',
	'on-demand':
		'On demand: always listening, but only what follows “Voice OS” is taken; say “end of turn” to send at once',
	'hands-free': 'Hands-free: always listening, speak over Voice OS to interrupt it',
};

const isTypingInField = (event: KeyboardEvent) =>
	event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;

export const BottomBar = ({
	state,
	isConnected,
	listenCommand,
	isAwake,
	ignoredAt,
	send,
	sendBinary,
	player,
	micStatus,
	onMicStatusChange,
}: BottomBarProps) => {
	const [draft, setDraft] = useState('');
	const micRef = useRef<Mic | null>(null);
	// Set synchronously on key down/up: a release while the mic is still opening must not be lost.
	const isPressedRef = useRef(false);
	const route = describeRouteChip(state, { draft });
	const voiceGate = describeVoiceGate(state.voiceGate);
	const isAlarm = route.isAnswering;

	useEffect(() => {
		player.setNotify((id) => send({ type: 'audio_done', id }));
	}, [player, send]);

	const getMic = useCallback(() => {
		micRef.current ??= new Mic({
			onAudio: sendBinary,
			onStop: () => {
				send({ type: 'ptt_stop' });

				if (!isPressedRef.current) {
					onMicStatusChange('idle');
				}
			},
		});

		return micRef.current;
	}, [send, sendBinary, onMicStatusChange]);

	const { listenMode, listenModeRef, chooseListenMode } = useListenMode({
		isConnected,
		listenCommand,
		getMic,
		send,
		onMicStatusChange,
	});

	useEffect(() => {
		// Already allowed: open now so the first press has its pre-roll; a listening mode opens its own.
		void isMicAllowed().then((isAllowed) =>
			isAllowed && listenModeRef.current === 'push'
				? getMic()
						.ensure()
						.catch(() => {
							// The first press opens it again and reports a denial.
						})
				: undefined,
		);
	}, [getMic]);

	const handleTalkStart = useCallback(async () => {
		// The mic already streams in the listening modes.
		if (isPressedRef.current || listenModeRef.current !== 'push') {
			return;
		}

		isPressedRef.current = true;
		// Read before stopping: stopping marks the speech as having ended now.
		const hasRecentSpeech = player.isAudibleWithin(PRE_ROLL_MS);
		player.stop();
		const microphone = getMic();
		const sampleRate = await microphone.ensure().catch(() => null);

		if (sampleRate === null) {
			isPressedRef.current = false;
			onMicStatusChange('denied');

			return;
		}

		// Released while the mic was opening: nothing was started, nothing to stop.
		if (!isPressedRef.current) {
			return;
		}

		// Speech that was audible just before the press would ride in on the pre-roll.
		microphone.press(() => send({ type: 'ptt_start', sampleRate }), {
			withPreRoll: !hasRecentSpeech,
		});
		onMicStatusChange('live');
	}, [getMic, player, send, onMicStatusChange]);

	const handleTalkStop = useCallback(() => {
		if (!isPressedRef.current) {
			return;
		}

		isPressedRef.current = false;
		// The tail keeps streaming briefly; the mic sends ptt_stop when it is done.
		micRef.current?.release();
	}, []);

	useEffect(() => {
		// Space is push-to-talk everywhere except while typing in a text field.
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.code !== 'Space' || event.repeat || isTypingInField(event)) {
				return;
			}

			event.preventDefault();
			void handleTalkStart();
		};

		const handleKeyUp = (event: KeyboardEvent) => {
			if (event.code !== 'Space' || isTypingInField(event)) {
				return;
			}

			event.preventDefault();
			handleTalkStop();
		};

		window.addEventListener('keydown', handleKeyDown);
		window.addEventListener('keyup', handleKeyUp);

		return () => {
			window.removeEventListener('keydown', handleKeyDown);
			window.removeEventListener('keyup', handleKeyUp);
		};
	}, [handleTalkStart, handleTalkStop]);

	const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();

		if (!draft.trim()) {
			return;
		}

		send({ type: 'utterance', text: draft.trim() });
		setDraft('');
	};

	const transcript = state.transcript;
	const isListening = listenMode !== 'push' && micStatus === 'live';
	const [isIgnoredShown, setIsIgnoredShown] = useState(false);

	// The call is heard: a chime, as a press would give the feeling of.
	useEffect(() => {
		if (isAwake) {
			player.playChime();
		}
	}, [isAwake, player]);

	// Speech without "Voice OS" was heard and left alone: a brief dot, so the mic is seen to work.
	useEffect(() => {
		if (!ignoredAt) {
			return;
		}

		setIsIgnoredShown(true);
		const timer = setTimeout(() => setIsIgnoredShown(false), IGNORED_DOT_MS);

		return () => clearTimeout(timer);
	}, [ignoredAt]);

	return (
		<footer className={`botbar ${isAlarm ? 'alarm' : ''}`}>
			<button
				type="button"
				className={`mic ${micStatus === 'live' ? 'live' : ''} ${micStatus === 'denied' ? 'off' : ''}`}
				aria-label={
					listenMode === 'push' ? 'Hold to talk' : isAwake ? 'Listening to you' : 'Listening'
				}
				title={MIC_TITLES[listenMode]}
				onPointerDown={() => void handleTalkStart()}
				onPointerUp={handleTalkStop}
				onPointerLeave={handleTalkStop}
			>
				<span className={`wave ${micStatus === 'live' ? 'live' : ''}`} aria-hidden="true">
					<i style={{ animationDelay: '0s' }} />
					<i style={{ animationDelay: '.1s' }} />
					<i style={{ animationDelay: '.2s' }} />
				</span>
			</button>
			<select
				className={`listen-mode ${listenMode === 'push' ? '' : 'on'} ${isAwake ? 'awake' : ''} ${
					isIgnoredShown ? 'ignored' : ''
				}`}
				value={listenMode}
				aria-label="Listening mode"
				title={MIC_TITLES[listenMode]}
				onChange={(event) => {
					if (isListenMode(event.target.value)) {
						chooseListenMode(event.target.value);
					}
				}}
			>
				<option value="push">Push to talk</option>
				<option value="on-demand">On demand · “Voice OS…”</option>
				<option value="hands-free">Hands-free</option>
			</select>
			<form onSubmit={handleSubmit}>
				<input
					value={micStatus === 'live' && transcript ? transcript.text : draft}
					onChange={(event) => setDraft(event.target.value)}
					placeholder={describeListening({
						mode: isListening ? listenMode : 'push',
						isAwake,
					})}
					aria-label="Say or type a command"
				/>
			</form>
			{voiceGate && (
				<span className="route voice-gate" title={voiceGate.title}>
					{voiceGate.label}
				</span>
			)}
			<span className={`route ${isAlarm ? 'alarm' : route.isForKernel ? 'kernel' : ''}`}>
				{route.label}
			</span>
		</footer>
	);
};

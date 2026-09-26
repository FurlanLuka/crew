import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, State } from '../../shared/protocol.js';
import { describeRouteChip } from '../../shared/route-chip.js';
import { Mic, isMicAllowed } from '../audio.js';
import { PRE_ROLL_MS } from '../ptt.js';
import type { ListenOff, MicStatus } from '../types.js';
import { useHandsFree } from '../use-hands-free.js';
import type { PcmPlayer } from '../use-speech-player.js';

interface BottomBarProps {
	state: State;
	isConnected: boolean;
	listenOff: ListenOff | null;
	send: (message: ClientMessage) => void;
	sendBinary: (chunk: ArrayBuffer) => void;
	player: PcmPlayer;
	micStatus: MicStatus;
	onMicStatusChange: (micStatus: MicStatus) => void;
}

const isTypingInField = (event: KeyboardEvent) =>
	event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;

export const BottomBar = ({
	state,
	isConnected,
	listenOff,
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

	const { handsFree, handsFreeRef, toggleHandsFree } = useHandsFree({
		isConnected,
		listenOff,
		getMic,
		send,
		onMicStatusChange,
	});

	useEffect(() => {
		// Already allowed: open now so the first press has its pre-roll; hands-free opens its own.
		void isMicAllowed().then((isAllowed) =>
			isAllowed && !handsFreeRef.current
				? getMic()
						.ensure()
						.catch(() => {
							// The first press opens it again and reports a denial.
						})
				: undefined,
		);
	}, [getMic]);

	const handleTalkStart = useCallback(async () => {
		// The mic already streams hands-free.
		if (isPressedRef.current || handsFreeRef.current) {
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
	const isListening = handsFree && micStatus === 'live';

	return (
		<footer className={`botbar ${isAlarm ? 'alarm' : ''}`}>
			<button
				type="button"
				className={`mic ${micStatus === 'live' ? 'live' : ''} ${micStatus === 'denied' ? 'off' : ''}`}
				aria-label={handsFree ? 'Listening' : 'Hold to talk'}
				title={handsFree ? 'Hands-free: just talk' : 'Hold Space or this button to talk'}
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
			<button
				type="button"
				className={`handsfree ${handsFree ? 'on' : ''}`}
				aria-pressed={handsFree}
				title="Hands-free: always listening, speak over Voice OS to interrupt it"
				onClick={toggleHandsFree}
			>
				hands-free
			</button>
			<form onSubmit={handleSubmit}>
				<input
					value={micStatus === 'live' && transcript ? transcript.text : draft}
					onChange={(event) => setDraft(event.target.value)}
					placeholder={
						isListening
							? 'Listening — just talk, or type here…'
							: 'Hold Space to talk, or type here…'
					}
					aria-label="Say or type a command"
				/>
			</form>
			<span className={`route ${isAlarm ? 'alarm' : route.isForKernel ? 'kernel' : ''}`}>
				{route.label}
			</span>
		</footer>
	);
};

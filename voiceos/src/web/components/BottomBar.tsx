import {
	type FormEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from 'react';
import type { ClientMessage, State } from '../../shared/protocol.js';
import { describeRouteChip } from '../../shared/route-chip.js';
import { readSessionLabel } from '../../shared/machines.js';
import { Mic, isMicAllowed } from '../audio.js';
import { PRE_ROLL_MS } from '../ptt.js';
import { describeListening, type InputMode, isListeningMode } from '../listen-mode.js';
import type { ListenCommand, MicStatus } from '../types.js';
import { useListenMode } from '../use-listen-mode.js';
import type { KeptDictation } from '../use-connection.js';
import type { PcmPlayer } from '../use-speech-player.js';
import { ModeMenu } from './ModeMenu.js';

interface BottomBarProps {
	state: State;
	isConnected: boolean;
	listenCommand: ListenCommand | null;
	// On demand: "Voice OS" was heard; ignoredAt: when speech without it was last left alone.
	isAwake: boolean;
	ignoredAt: number;
	// A dictation the server could not send: it comes back into the input.
	keptDictation: KeptDictation | null;
	send: (message: ClientMessage) => void;
	sendBinary: (chunk: ArrayBuffer) => void;
	player: PcmPlayer;
	micStatus: MicStatus;
	onMicStatusChange: (micStatus: MicStatus) => void;
}

const IGNORED_DOT_MS = 900;
// Discard asks once more: a misclick must not throw away a long dictation.
const DISCARD_CONFIRM_MS = 3000;

const MIC_TITLES: Record<InputMode, string> = {
	push: 'Hold Space or this button to talk',
	'on-demand':
		'On demand: always listening, but only what follows “Voice OS” is taken; say “end of turn” to send at once',
	'hands-free': 'Hands-free: always listening, speak over Voice OS to interrupt it',
	dictation: 'Dictation: click to start, click again or Send when done',
};

const isTypingInField = (event: KeyboardEvent) =>
	event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;

// The mode menu and the dictation buttons take Space as their own click.
const isOnOwnControl = (event: KeyboardEvent) =>
	event.target instanceof Element && event.target.closest('.mode-wrap, .composer-side') !== null;

const formatElapsed = (ms: number): string => {
	const seconds = Math.max(0, Math.floor(ms / 1000));

	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

// Where a dictation goes when sent: the session on screen, unless it waits on an answer.
const describeDictationTarget = (state: State): string => {
	const ref = state.view.kind === 'session' ? state.view.ref : null;

	if (!ref || !state.sessions[ref]) {
		return 'Stays in the box';
	}

	return state.asks.some((ask) => ask.ref === ref) ? 'Stays in the box' : `→ ${ref}`;
};

const useElapsed = (since: number | null): number => {
	const [now, setNow] = useState(Date.now());

	useEffect(() => {
		if (since === null) {
			return;
		}

		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);

		return () => clearInterval(timer);
	}, [since]);

	return since === null ? 0 : now - since;
};

export const BottomBar = ({
	state,
	isConnected,
	listenCommand,
	isAwake,
	ignoredAt,
	keptDictation,
	send,
	sendBinary,
	player,
	micStatus,
	onMicStatusChange,
}: BottomBarProps) => {
	const [draft, setDraft] = useState('');
	const micRef = useRef<Mic | null>(null);
	const fieldRef = useRef<HTMLTextAreaElement | null>(null);
	// Set synchronously on key down/up: a release while the mic is still opening must not be lost.
	const isPressedRef = useRef(false);
	const [dictationStartedAt, setDictationStartedAt] = useState<number | null>(null);
	const [isDiscardArmed, setIsDiscardArmed] = useState(false);
	const isDictating = dictationStartedAt !== null;
	const elapsedMs = useElapsed(dictationStartedAt);
	const route = describeRouteChip(state, { draft });
	const isAlarm = route.isAnswering && !isDictating;

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
			isAllowed && !isListeningMode(listenModeRef.current)
				? getMic()
						.ensure()
						.catch(() => {
							// The first press opens it again and reports a denial.
						})
				: undefined,
		);
	}, [getMic]);

	const handleTalkStart = useCallback(
		async ({ isDictation = false }: { isDictation?: boolean } = {}) => {
			// The mic already streams in the listening modes.
			if (isPressedRef.current || isListeningMode(listenModeRef.current)) {
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
			microphone.press(
				() =>
					send({
						type: 'ptt_start',
						sampleRate,
						...(isDictation ? { dictation: true as const } : {}),
					}),
				{ withPreRoll: !hasRecentSpeech },
			);
			onMicStatusChange('live');

			if (isDictation) {
				setDictationStartedAt(Date.now());
			}
		},
		[getMic, player, send, onMicStatusChange],
	);

	const handleTalkStop = useCallback(() => {
		if (!isPressedRef.current) {
			return;
		}

		isPressedRef.current = false;
		setDictationStartedAt(null);
		setIsDiscardArmed(false);
		// The tail keeps streaming briefly; the mic sends ptt_stop when it is done.
		micRef.current?.release();
	}, []);

	const handleDiscard = useCallback(() => {
		// Words already heard: one more click, so a slip of the mouse loses nothing.
		if (state.transcript?.text && !isDiscardArmed) {
			setIsDiscardArmed(true);

			return;
		}

		send({ type: 'ptt_cancel' });
		handleTalkStop();
	}, [state.transcript?.text, isDiscardArmed, send, handleTalkStop]);

	useEffect(() => {
		if (!isDiscardArmed) {
			return;
		}

		const timer = setTimeout(() => setIsDiscardArmed(false), DISCARD_CONFIRM_MS);

		return () => clearTimeout(timer);
	}, [isDiscardArmed]);

	// The server sends a dictation when its tab drops; this page only has to stop recording.
	useEffect(() => {
		if (!isConnected && isDictating) {
			handleTalkStop();
		}
	}, [isConnected, isDictating, handleTalkStop]);

	useEffect(() => {
		if (keptDictation) {
			setDraft(keptDictation.text);
			fieldRef.current?.focus();
		}
	}, [keptDictation]);

	const chooseMode = useCallback(
		(mode: InputMode) => {
			// Switching away mid-dictation sends it: nothing said is ever dropped by a menu.
			if (isDictating && mode !== 'dictation') {
				handleTalkStop();
			}

			chooseListenMode(mode);
		},
		[isDictating, handleTalkStop, chooseListenMode],
	);

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (
				event.code !== 'Space' ||
				event.repeat ||
				isTypingInField(event) ||
				isOnOwnControl(event)
			) {
				return;
			}

			event.preventDefault();

			// Dictation: Space starts it; ending it is a deliberate click on Send.
			if (listenModeRef.current === 'dictation') {
				if (!isPressedRef.current) {
					void handleTalkStart({ isDictation: true });
				}

				return;
			}

			void handleTalkStart();
		};

		const handleKeyUp = (event: KeyboardEvent) => {
			if (event.code !== 'Space' || isTypingInField(event) || isOnOwnControl(event)) {
				return;
			}

			// Also keeps a focused mic button from taking the key-up as a click that would end it.
			event.preventDefault();

			if (listenModeRef.current !== 'dictation') {
				handleTalkStop();
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		window.addEventListener('keyup', handleKeyUp);

		return () => {
			window.removeEventListener('keydown', handleKeyDown);
			window.removeEventListener('keyup', handleKeyUp);
		};
	}, [handleTalkStart, handleTalkStop]);

	const submitDraft = () => {
		if (!draft.trim()) {
			return;
		}

		send({ type: 'utterance', text: draft.trim() });
		setDraft('');
	};

	const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		submitDraft();
	};

	const handleFieldKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
		// Enter sends, Shift+Enter is a new line; a composing IME keeps its Enter.
		if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			submitDraft();
		}
	};

	const transcript = state.transcript;
	const isListening = isListeningMode(listenMode) && micStatus === 'live';
	const [isIgnoredShown, setIsIgnoredShown] = useState(false);
	const isShowingTranscript = micStatus === 'live' && Boolean(transcript);
	const fieldValue = isShowingTranscript && transcript ? transcript.text : draft;

	// Grows with the words up to its CSS max height, then scrolls; live words keep their end in view.
	useLayoutEffect(() => {
		const field = fieldRef.current;

		if (!field) {
			return;
		}

		field.style.height = 'auto';
		field.style.height = `${field.scrollHeight}px`;

		if (isShowingTranscript) {
			field.scrollTop = field.scrollHeight;
		}
	}, [fieldValue, isShowingTranscript]);

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

	const isDictationMode = listenMode === 'dictation';
	// A conversation with a session not on screen: the chip says so, and lapses with it.
	const screenRef = state.view.kind === 'session' ? state.view.ref : null;
	const subjectRef =
		state.exchange && state.exchange.ref !== screenRef && !isDictationMode
			? state.exchange.ref
			: null;
	const routeLabel = isDictationMode ? describeDictationTarget(state) : route.label;
	const routeClass = isDictationMode
		? 'dictation'
		: isAlarm
			? 'alarm'
			: route.isForKernel
				? 'kernel'
				: '';

	return (
		<footer className={`botbar ${isAlarm ? 'alarm' : ''}`}>
			<div className="voice-controls">
				<button
					type="button"
					className={`mic ${micStatus === 'live' ? 'live' : ''} ${micStatus === 'denied' ? 'off' : ''} ${
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
							? () => (isDictating ? handleTalkStop() : void handleTalkStart({ isDictation: true }))
							: undefined
					}
					onPointerDown={isDictationMode ? undefined : () => void handleTalkStart()}
					onPointerUp={isDictationMode ? undefined : handleTalkStop}
					onPointerLeave={isDictationMode ? undefined : handleTalkStop}
				>
					<span className={`wave ${micStatus === 'live' ? 'live' : ''}`} aria-hidden="true">
						<i style={{ animationDelay: '0s' }} />
						<i style={{ animationDelay: '.1s' }} />
						<i style={{ animationDelay: '.2s' }} />
					</span>
				</button>
				<ModeMenu
					mode={listenMode}
					onChoose={chooseMode}
					isOn={isListening}
					isAwake={isAwake}
					isIgnored={isIgnoredShown}
					isDenied={micStatus === 'denied'}
					title={MIC_TITLES[listenMode]}
				/>
			</div>
			<form
				className={`composer ${isDictating ? 'dictating' : ''} ${isShowingTranscript ? 'hearing' : ''}`}
				onSubmit={handleSubmit}
			>
				<textarea
					ref={fieldRef}
					rows={1}
					value={fieldValue}
					readOnly={isDictating}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={handleFieldKey}
					placeholder={describeListening({
						mode: isListening || isDictationMode ? listenMode : 'push',
						isAwake,
						isDictating,
					})}
					aria-label="Say or type a command"
				/>
				<div className="composer-side">
					{isDictating ? (
						<>
							<span className="dictation-clock" title="Dictating for">
								<i aria-hidden="true" />
								{formatElapsed(elapsedMs)}
							</span>
							<button
								type="button"
								className={`pill-button ghost ${isDiscardArmed ? 'armed' : ''}`}
								onClick={handleDiscard}
							>
								{isDiscardArmed ? 'Discard all?' : 'Discard'}
							</button>
							<button type="button" className="pill-button primary" onClick={handleTalkStop}>
								Send
							</button>
						</>
					) : null}
					{subjectRef ? (
						<span className="talking-with">
							<button
								type="button"
								className="talking-with-name"
								title="Your follow-ups go to this session. Click to switch to it."
								onClick={() =>
									send({
										type: 'action',
										action: { type: 'switch_view', view: { kind: 'session', ref: subjectRef } },
									})
								}
							>
								Talking with {readSessionLabel(state, subjectRef)}
							</button>
							<button
								type="button"
								className="talking-with-clear"
								aria-label="Stop talking with it"
								title="Follow-ups go to the session on screen again"
								onClick={() => send({ type: 'action', action: { type: 'clear_exchange' } })}
							>
								×
							</button>
						</span>
					) : (
						<span className={`route ${routeClass}`}>{routeLabel}</span>
					)}
				</div>
			</form>
		</footer>
	);
};

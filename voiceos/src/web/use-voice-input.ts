// This tab's mic: push to talk, the listening modes and dictation. Owned by Voice OS's page, so its
// voice bar and its settings set the same mode, and leaving /voice (unmounting) stops listening.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, State } from '../shared/protocol.js';
import { Mic, isMicAllowed } from './audio.js';
import { clientLog } from './client-log.js';
import { isInDialog } from './in-dialog.js';
import { type InputMode, isListeningMode } from './listen-mode.js';
import { PRE_ROLL_MS } from './ptt.js';
import type { ListenCommand, MicStatus } from './types.js';
import { useListenMode } from './use-listen-mode.js';
import type { PcmPlayer } from './use-speech-player.js';

// Discard asks once more: a misclick must not throw away a long dictation.
const DISCARD_CONFIRM_MS = 3000;

interface UseVoiceInputParams {
	state: State;
	isConnected: boolean;
	listenCommand: ListenCommand | null;
	send: (message: ClientMessage) => void;
	sendBinary: (chunk: ArrayBuffer) => void;
	player: PcmPlayer;
	micStatus: MicStatus;
	onMicStatusChange: (micStatus: MicStatus) => void;
	// Another screen is the main one: this one neither listens nor speaks until it is used here.
	isMain: boolean;
}

interface TalkGate {
	isPressed: boolean;
	isMain: boolean;
	isVoiceOff: boolean;
	isOnDiscord: boolean;
	mode: InputMode;
}

// Why a press does nothing here, or null when it opens the mic: each reason goes to the log.
export const readTalkRefusal = ({
	isPressed,
	isMain,
	isVoiceOff,
	isOnDiscord,
	mode,
}: TalkGate): string | null => {
	if (isPressed) {
		return 'already pressed';
	}

	if (!isMain) {
		return 'another screen is the main one';
	}

	if (isVoiceOff) {
		return 'voice is off';
	}

	if (isOnDiscord) {
		return 'Discord has the mic';
	}

	if (mode === 'text') {
		return 'text only';
	}

	return isListeningMode(mode) ? 'a listening mode streams already' : null;
};

const isTypingInField = (event: KeyboardEvent) =>
	event.target instanceof HTMLInputElement ||
	event.target instanceof HTMLTextAreaElement ||
	event.target instanceof HTMLSelectElement;

// The mode menu, the dictation buttons and a prompt's answers take Space as their own click.
const isOnOwnControl = (event: KeyboardEvent) =>
	event.target instanceof Element &&
	event.target.closest('.mode-wrap, .composer-side, .vs-set, .sheet, .qchip-wrap') !== null;

export const useVoiceInput = ({
	state,
	isConnected,
	listenCommand,
	send,
	sendBinary,
	player,
	micStatus,
	onMicStatusChange,
	isMain,
}: UseVoiceInputParams) => {
	const micRef = useRef<Mic | null>(null);
	// Set synchronously on key down/up: a release while the mic is still opening must not be lost.
	const isPressedRef = useRef(false);
	const [dictationStartedAt, setDictationStartedAt] = useState<number | null>(null);
	const [isDiscardArmed, setIsDiscardArmed] = useState(false);
	const isDictating = dictationStartedAt !== null;
	const isOnDiscordRef = useRef(false);
	isOnDiscordRef.current = Boolean(state.discord?.isOwnerIn);
	// Voice off, or another screen holding the main role: nothing listens or plays here.
	const isVoiceOff = state.voiceOff || !isMain;
	const isVoiceOffRef = useRef(isVoiceOff);
	isVoiceOffRef.current = isVoiceOff;
	const isMainRef = useRef(isMain);
	isMainRef.current = isMain;
	const isVoiceOffStateRef = useRef(state.voiceOff);
	isVoiceOffStateRef.current = state.voiceOff;

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

	// Leaving Voice OS lets go of the device: the browser's recording light goes out.
	useEffect(() => () => micRef.current?.close(), []);

	const { listenMode, listenModeRef, chooseListenMode } = useListenMode({
		isConnected,
		listenCommand,
		isVoiceOff,
		getMic,
		send,
		onMicStatusChange,
	});

	// Text only stays quiet in this tab: speech is acknowledged unplayed, so the server never waits on it.
	useEffect(() => player.setMuted(listenMode === 'text' || !isMain), [player, listenMode, isMain]);

	// Voice off: what plays stops and the device is let go, so the browser's recording light goes out.
	useEffect(() => {
		if (!isVoiceOff) {
			return;
		}

		isPressedRef.current = false;
		setDictationStartedAt(null);
		player.stop();
		micRef.current?.close();
		onMicStatusChange('idle');
	}, [isVoiceOff, player, onMicStatusChange]);

	useEffect(() => {
		// Already allowed: open now so the first press has its pre-roll; a listening mode opens its own.
		if (isVoiceOff) {
			return;
		}

		void isMicAllowed().then((isAllowed) =>
			isAllowed &&
			!isListeningMode(listenModeRef.current) &&
			listenModeRef.current !== 'text' &&
			!isVoiceOffRef.current
				? getMic()
						.ensure()
						.catch(() => {
							// The first press opens it again and reports a denial.
						})
				: undefined,
		);
	}, [getMic, isVoiceOff]);

	const handleTalkStart = useCallback(
		async ({ isDictation = false }: { isDictation?: boolean } = {}) => {
			const refusal = readTalkRefusal({
				isPressed: isPressedRef.current,
				isMain: isMainRef.current,
				isVoiceOff: isVoiceOffStateRef.current,
				isOnDiscord: isOnDiscordRef.current,
				mode: listenModeRef.current,
			});

			if (refusal) {
				clientLog('info', 'mic', 'press ignored', { reason: refusal });

				return;
			}

			isPressedRef.current = true;
			// The mic opens first, in this same turn: iOS asks for it and starts its audio only inside
			// the gesture, and anything awaited before it would end the gesture.
			const microphone = getMic();
			const opening = microphone.ensure();
			microphone.wake();
			// Read before stopping: stopping marks the speech as having ended now.
			const hasRecentSpeech = player.isAudibleWithin(PRE_ROLL_MS);
			player.stop();
			const sampleRate = await opening.catch(() => null);

			if (sampleRate === null) {
				isPressedRef.current = false;
				clientLog('warn', 'mic', 'mic denied');
				onMicStatusChange('denied');

				return;
			}

			// Released while the mic was opening (a tap): nothing was started, nothing to stop. The
			// permission it asked for stays granted.
			if (!isPressedRef.current) {
				clientLog('info', 'mic', 'released before the mic opened');

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
		// A touch's release is the gesture iOS counts: a device still suspended starts here.
		micRef.current?.wake();
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

	const chooseMode = useCallback(
		(mode: InputMode) => {
			// Switching away mid-dictation sends it: nothing said is ever dropped by a menu.
			if (isDictating && mode !== 'dictation') {
				handleTalkStop();
			}

			// Text only: the device is let go, so the recording light goes out.
			if (mode === 'text') {
				micRef.current?.close();
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
				listenModeRef.current === 'text' ||
				isTypingInField(event) ||
				isOnOwnControl(event) ||
				isInDialog(event)
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
			// A live press always takes its release, wherever focus moved meanwhile: a swallowed key-up
			// left the mic open for minutes (debug note 30).
			const isLivePress = isPressedRef.current && listenModeRef.current !== 'dictation';

			if (
				event.code !== 'Space' ||
				(!isLivePress && (isTypingInField(event) || isOnOwnControl(event) || isInDialog(event)))
			) {
				return;
			}

			// Also keeps a focused mic button from taking the key-up as a click that would end it.
			event.preventDefault();

			if (listenModeRef.current !== 'dictation') {
				handleTalkStop();
			}
		};

		// A page that loses focus or is hidden never sees the key-up: the press ends here instead.
		// A dictation is ended only by Send, so it carries on.
		const endPressOnLeave = () => {
			if (listenModeRef.current !== 'dictation') {
				handleTalkStop();
			}
		};

		const handleVisibilityChange = () => {
			if (document.visibilityState === 'hidden') {
				endPressOnLeave();
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		window.addEventListener('keyup', handleKeyUp);
		window.addEventListener('blur', endPressOnLeave);
		document.addEventListener('visibilitychange', handleVisibilityChange);

		return () => {
			window.removeEventListener('keydown', handleKeyDown);
			window.removeEventListener('keyup', handleKeyUp);
			window.removeEventListener('blur', endPressOnLeave);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	}, [handleTalkStart, handleTalkStop]);

	return {
		listenMode,
		chooseMode,
		micStatus,
		isDictating,
		dictationStartedAt,
		isDiscardArmed,
		handleTalkStart,
		handleTalkStop,
		handleDiscard,
	};
};

export type VoiceInput = ReturnType<typeof useVoiceInput>;

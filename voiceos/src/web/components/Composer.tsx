// The field in the voice bar: typed words, live words as they are heard, a dictation's controls, and
// the chip that says where the words go.
import {
	type FormEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from 'react';
import { isActive } from '../../shared/active.js';
import { readSessionLabel } from '../../shared/machines.js';
import { MAX_TEXT_CHARS, type ClientMessage, type State } from '../../shared/protocol.js';
import { describeRouteChip } from '../../shared/route-chip.js';
import { describeListening, isListeningMode } from '../listen-mode.js';
import { AttachButton } from './AttachmentChips.js';
import { SlashMenu } from './SlashMenu.js';
import { ModeChip } from './ModeChip.js';
import { ContextMeter } from './ContextMeter.js';
import { readScreenRef } from '../../state/helpers.js';
import { useSlashCommands } from '../use-slash-commands.js';
import { ATTACHED_ONLY_TEXT, type Attachments } from '../use-attachments.js';
import type { KeptDictation } from '../use-connection.js';
import type { VoiceInput } from '../use-voice-input.js';

interface ComposerProps {
	state: State;
	voice: VoiceInput;
	isAwake: boolean;
	isOnDiscord: boolean;
	keptDictation: KeptDictation | null;
	attachments: Attachments;
	send: (message: ClientMessage) => void;
}

const formatElapsed = (ms: number): string => {
	const seconds = Math.max(0, Math.floor(ms / 1000));

	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

// The session on screen when it is not active: nothing to type to, only to activate.
const readInactiveScreen = (state: State): string | null => {
	const ref = state.view.kind === 'session' ? state.view.ref : null;

	return ref && state.sessions[ref] && !isActive(state, ref) ? ref : null;
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

export const Composer = ({
	state,
	voice,
	isAwake,
	isOnDiscord,
	keptDictation,
	attachments,
	send,
}: ComposerProps) => {
	const [draft, setDraft] = useState('');
	// Enter pressed while a file still uploads: sent once it is in, so the words take it along.
	const [isHeld, setIsHeld] = useState(false);
	const fieldRef = useRef<HTMLTextAreaElement | null>(null);
	const { listenMode, micStatus, isDictating } = voice;
	const elapsedMs = useElapsed(voice.dictationStartedAt);
	const route = describeRouteChip(state, { draft });
	const isAlarm = route.isAnswering && !isDictating;
	const discord = isOnDiscord ? state.discord : null;
	const onScreen = readScreenRef(state);
	const screenRef = onScreen && state.sessions[onScreen] ? onScreen : null;
	const slash = useSlashCommands({
		state,
		sessionRef: screenRef,
		text: draft,
		setText: setDraft,
		send,
	});

	useEffect(() => {
		if (keptDictation) {
			// After anything already typed: a stuck press can end while the developer types.
			setDraft((typed) =>
				typed.trim() ? `${typed.trimEnd()} ${keptDictation.text}` : keptDictation.text,
			);
			fieldRef.current?.focus();
		}
	}, [keptDictation]);

	const draftChars = draft.trim().length;
	// Sent anyway, the gateway refused it and the words were gone: they stay in the field instead.
	const isTooLong = draftChars > MAX_TEXT_CHARS;

	const hasFiles = attachments.waiting.length > 0 || attachments.isUploading;

	const submitDraft = () => {
		if ((!draft.trim() && !hasFiles) || isTooLong) {
			return;
		}

		if (slash.runTyped(draft)) {
			setDraft('');

			return;
		}

		if (attachments.isUploading) {
			setIsHeld(true);

			return;
		}

		send({ type: 'utterance', text: draft.trim() || ATTACHED_ONLY_TEXT });
		setDraft('');
	};

	useEffect(() => {
		if (isHeld && !attachments.isUploading) {
			setIsHeld(false);
			submitDraft();
		}
	}, [isHeld, attachments.isUploading]);

	const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		submitDraft();
	};

	const handleFieldKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
		if (slash.handleKey(event)) {
			return;
		}

		// Enter sends, Shift+Enter is a new line; a composing IME keeps its Enter.
		if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			submitDraft();
		}
	};

	const transcript = state.transcript;
	const isListening = isListeningMode(listenMode) && micStatus === 'live';
	const isShowingTranscript = (micStatus === 'live' || discord !== null) && Boolean(transcript);
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

	const isDictationMode = listenMode === 'dictation';
	// A dictation or live words already under way keep their box: what was said is never hidden.
	const inactiveRef = isDictating || isShowingTranscript ? null : readInactiveScreen(state);
	const routeLabel = isDictationMode ? describeDictationTarget(state) : route.label;
	const routeClass = isDictationMode
		? 'dictation'
		: isAlarm
			? 'alarm'
			: route.isForKernel
				? 'kernel'
				: '';

	if (inactiveRef) {
		return (
			<div className="vo-field composer inactive">
				<span className="c-dim">
					{readSessionLabel(state, inactiveRef)} isn't active: activate it to talk to it.
				</span>
				<AttachButton attachments={attachments} />
				<button
					type="button"
					className="btn sm primary"
					onClick={() => send({ type: 'action', action: { type: 'activate', ref: inactiveRef } })}
				>
					Activate
				</button>
			</div>
		);
	}

	return (
		<form
			className={`vo-field composer ${isDictating ? 'dictating' : ''} ${isShowingTranscript ? 'hearing' : ''} ${
				isAlarm ? 'alarm' : ''
			} ${discord ? 'discord' : ''}`}
			onSubmit={handleSubmit}
		>
			<SlashMenu slash={slash} onPicked={() => fieldRef.current?.focus()} />
			{screenRef ? <ModeChip state={state} sessionRef={screenRef} send={send} /> : null}
			<textarea
				ref={fieldRef}
				rows={1}
				value={fieldValue}
				readOnly={isDictating}
				onChange={(event) => setDraft(event.target.value)}
				onKeyDown={handleFieldKey}
				placeholder={
					state.voiceOff
						? 'Voice is off · type a command'
						: discord
							? discord.isHearing
								? 'Listening on Discord · what you say shows here as you speak'
								: 'Not hearing you in Discord: pick a mode to try again, or type'
							: describeListening({
									mode: isListening || isDictationMode ? listenMode : 'push',
									isAwake,
									isDictating,
								})
				}
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
							className={`btn sm ghost ${voice.isDiscardArmed ? 'armed' : ''}`}
							onClick={voice.handleDiscard}
						>
							{voice.isDiscardArmed ? 'Discard all?' : 'Discard'}
						</button>
						<button type="button" className="btn sm primary" onClick={voice.handleTalkStop}>
							Send
						</button>
					</>
				) : null}
				{isHeld ? <span className="c-dim">sending once uploaded…</span> : null}
				{!isDictating && attachments.ref ? <AttachButton attachments={attachments} /> : null}
				{isTooLong ? (
					<span className="too-long" role="alert">
						Too long to send: {draftChars.toLocaleString('en')} of{' '}
						{MAX_TEXT_CHARS.toLocaleString('en')} characters
					</span>
				) : null}
				{!isDictating && screenRef && state.sessions[screenRef]?.context ? (
					<ContextMeter
						sessionRef={screenRef}
						context={state.sessions[screenRef].context}
						send={send}
					/>
				) : null}
				<span className={`vo-route route ${routeClass}`}>{routeLabel}</span>
			</div>
		</form>
	);
};

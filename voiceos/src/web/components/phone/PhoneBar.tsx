// The phone's bar, one field: the listening mode on the left, the words in the middle, and the mode's
// one action on the right — hold the mic (push to talk), send (dictation, text), or nothing (the
// listening modes). Only Text only takes typing: everywhere else the middle is where what you say
// shows up. No attachments, no route chip and no spoken line: on a phone you hear it.
import {
	type FormEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from 'react';
import { isActive } from '../../../shared/active.js';
import { readSessionLabel } from '../../../shared/machines.js';
import { type ClientMessage, MAX_TEXT_CHARS, type State } from '../../../shared/protocol.js';
import { readScreenRef } from '../../../state/helpers.js';
import { INPUT_MODES, type InputMode, isListeningMode } from '../../listen-mode.js';
import { describeMicHelp, readPlatform } from '../../phone.js';
import type { MicStatus } from '../../types.js';
import { useSlashCommands } from '../../use-slash-commands.js';
import type { KeptDictation } from '../../use-connection.js';
import type { VoiceInput } from '../../use-voice-input.js';
import { MODE_COPY } from '../ModeMenu.js';
import { MomentsRow } from '../MomentsRow.js';
import { isStandalone } from './InstallGuide.js';
import { SlashMenu } from '../SlashMenu.js';
import { ModeSheet } from './ModeSheet.js';
import { HoldMicIcon, SendIcon } from './phone-icons.js';

const DISCORD_MODES: InputMode[] = ['on-demand', 'hands-free'];

interface HintParams {
	mode: InputMode;
	micStatus: MicStatus;
	isAwake: boolean;
	isDictating: boolean;
}

// What the middle says while nothing is heard: what to do in this mode.
export const describePhoneHint = ({
	mode,
	micStatus,
	isAwake,
	isDictating,
}: HintParams): string => {
	if (micStatus === 'denied' && mode !== 'text') {
		return 'Microphone blocked';
	}

	switch (mode) {
		case 'push':
			return 'Hold the mic to talk';
		case 'dictation':
			return isDictating ? 'Dictating: take your time' : 'Tap the mic to dictate';
		case 'hands-free':
			return 'Listening: just talk';
		case 'on-demand':
			return isAwake ? 'Listening to you' : 'Say “Voice OS”, then your command';
		case 'text':
			return 'Type a message';
	}
};

interface PhoneBarProps {
	state: State;
	voice: VoiceInput;
	isAwake: boolean;
	// A dictation the server could not send (the session waits on an answer): it lands in the box.
	keptDictation: KeptDictation | null;
	send: (message: ClientMessage) => void;
}

const readInactiveScreen = (state: State): string | null => {
	const ref = readScreenRef(state);

	return ref && state.sessions[ref] && !isActive(state, ref) ? ref : null;
};

interface HoldMicProps {
	voice: VoiceInput;
	isLive: boolean;
}

// Held, not clicked: the pointer is captured so a thumb sliding off the button still lets go here.
const HoldMic = ({ voice, isLive }: HoldMicProps) => {
	const press = (event: PointerEvent<HTMLButtonElement>) => {
		// The mic first, before anything else can throw or wait: iOS asks for it only inside the press.
		void voice.handleTalkStart();
		event.preventDefault();

		try {
			event.currentTarget.setPointerCapture(event.pointerId);
		} catch {
			// A touch is captured by its target anyway; some browsers refuse an explicit capture.
		}
	};

	return (
		<button
			type="button"
			className={`talk-btn ${isLive ? 'live' : ''}`}
			aria-label="Hold to talk"
			onPointerDown={press}
			onPointerUp={voice.handleTalkStop}
			onPointerCancel={voice.handleTalkStop}
			onContextMenu={(event) => event.preventDefault()}
		>
			<HoldMicIcon />
		</button>
	);
};

export const PhoneBar = ({ state, voice, isAwake, keptDictation, send }: PhoneBarProps) => {
	const [isMenuOpen, setIsMenuOpen] = useState(false);
	const [draft, setDraft] = useState('');
	const fieldRef = useRef<HTMLTextAreaElement | null>(null);
	const { listenMode, micStatus, isDictating } = voice;
	const discord = state.discord?.isOwnerIn ? state.discord : null;
	// Voice off, or Discord holding the mic: the bar is a message box, whatever the mode says.
	const mode: InputMode = state.voiceOff || discord ? 'text' : listenMode;
	const screenRef = readScreenRef(state);
	const sessionRef = screenRef && state.sessions[screenRef] ? screenRef : null;
	const slash = useSlashCommands({ state, sessionRef, text: draft, setText: setDraft, send });
	const transcript = state.transcript;
	const isShowingWords = Boolean(transcript?.text) && (micStatus === 'live' || discord !== null);
	const isHolding = listenMode === 'push' && micStatus === 'live';
	const isTooLong = draft.trim().length > MAX_TEXT_CHARS;
	const inactiveRef = isShowingWords || isDictating ? null : readInactiveScreen(state);
	// Words in the box are never hidden by a mode: a kept dictation shows, whatever the mode.
	const isTyping = mode === 'text' || draft.length > 0;

	useEffect(() => {
		if (keptDictation) {
			setDraft((typed) =>
				typed.trim() ? `${typed.trimEnd()} ${keptDictation.text}` : keptDictation.text,
			);
		}
	}, [keptDictation]);

	useLayoutEffect(() => {
		const field = fieldRef.current;

		if (field) {
			field.style.height = 'auto';
			field.style.height = `${field.scrollHeight}px`;
		}
	}, [draft, mode]);

	const submit = (event?: FormEvent) => {
		event?.preventDefault();

		if (!draft.trim() || isTooLong) {
			return;
		}

		if (!slash.runTyped(draft)) {
			send({ type: 'utterance', text: draft.trim() });
		}

		setDraft('');
	};

	const handleFieldKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
		if (slash.handleKey(event)) {
			return;
		}

		if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			submit();
		}
	};

	const chooseMode = (chosen: InputMode) =>
		discord
			? isListeningMode(chosen) && send({ type: 'discord_listen', mode: chosen })
			: voice.chooseMode(chosen);

	if (inactiveRef) {
		return (
			<footer className="vo-bar phone-bar">
				<div className="vo-field composer mbar inactive">
					<span className="words hint">{readSessionLabel(state, inactiveRef)} isn't active</span>
					<button
						type="button"
						className="btn sm primary"
						onClick={() => send({ type: 'action', action: { type: 'activate', ref: inactiveRef } })}
					>
						Activate
					</button>
				</div>
			</footer>
		);
	}

	const middle = isShowingWords ? (
		<span className="words" aria-live="polite">
			{transcript?.text}
		</span>
	) : isTyping ? (
		<textarea
			ref={fieldRef}
			rows={1}
			value={draft}
			onChange={(event) => setDraft(event.target.value)}
			onKeyDown={handleFieldKey}
			placeholder={
				state.voiceOff
					? 'Voice is off · type a message'
					: `Message ${sessionRef ? readSessionLabel(state, sessionRef) : 'Voice OS'}`
			}
			aria-label="Type a message"
		/>
	) : (
		<span className="words hint">
			{describePhoneHint({ mode, micStatus, isAwake, isDictating })}
		</span>
	);

	const right =
		isTyping && !isShowingWords ? (
			<button type="submit" className="send-btn" aria-label="Send" disabled={!draft.trim()}>
				<SendIcon />
			</button>
		) : mode === 'push' ? (
			<HoldMic voice={voice} isLive={isHolding} />
		) : mode === 'dictation' ? (
			isDictating ? (
				<button
					type="button"
					className="send-btn"
					aria-label="Send the dictation"
					onClick={voice.handleTalkStop}
				>
					<SendIcon />
				</button>
			) : (
				<button
					type="button"
					className="talk-btn"
					aria-label="Start dictating"
					onClick={() => void voice.handleTalkStart({ isDictation: true })}
				>
					<HoldMicIcon />
				</button>
			)
		) : null;

	const isTall = isDictating || draft.includes('\n');
	const fieldClass = [
		'vo-field composer mbar',
		isShowingWords || isHolding ? 'hot' : '',
		isTall ? 'tall' : '',
	]
		.filter(Boolean)
		.join(' ');

	return (
		<footer className="vo-bar phone-bar">
			<MomentsRow state={state} dispatch={(action) => send({ type: 'action', action })} />
			{micStatus === 'denied' && mode !== 'text' && (
				<p className="phone-note mic-help" role="alert">
					{describeMicHelp(
						readPlatform(navigator.userAgent, navigator.maxTouchPoints),
						isStandalone(),
					)}
				</p>
			)}
			<form className={fieldClass} data-mode={mode} onSubmit={submit}>
				{isTyping && <SlashMenu slash={slash} onPicked={() => fieldRef.current?.focus()} />}
				<button
					type="button"
					className={`mode-btn ${isMenuOpen ? 'open' : ''}`}
					aria-label="Listening mode"
					aria-haspopup="menu"
					aria-expanded={isMenuOpen}
					title={MODE_COPY[discord ? discord.mode : listenMode].name}
					onClick={() => setIsMenuOpen((wasOpen) => !wasOpen)}
				>
					{MODE_COPY[discord ? discord.mode : listenMode].icon}
				</button>
				{middle}
				{right}
			</form>
			{isTooLong && (
				<p className="phone-note" role="alert">
					Too long to send: {draft.trim().length.toLocaleString('en')} of{' '}
					{MAX_TEXT_CHARS.toLocaleString('en')} characters
				</p>
			)}
			{isMenuOpen && (
				<ModeSheet
					mode={discord ? discord.mode : listenMode}
					modes={discord ? DISCORD_MODES : INPUT_MODES}
					onChoose={chooseMode}
					onClose={() => setIsMenuOpen(false)}
				/>
			)}
		</footer>
	);
};

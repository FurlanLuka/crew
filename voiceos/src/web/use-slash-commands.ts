// The "/" menu of a session's box and what Enter does with a Voice OS command. Claude's commands and
// skills are only filled in: the box sends them as words, as before.
import { type KeyboardEvent, useEffect, useState } from 'react';
import { LOCAL_MACHINE } from '../shared/machine-ref.js';
import type { Action, ClientMessage, State } from '../shared/protocol.js';
import { isOk, runCrew } from './setup/api.js';
import {
	filterCommands,
	type MenuEntry,
	parseVoiceOsCommand,
	readTypedName,
	type SlashAction,
} from './slash-commands.js';

// What a Voice OS command said back, under the box; `restart` offers the restart an update needs.
export interface SlashLine {
	text: string;
	isError?: true;
	offersRestart?: true;
}

export interface SlashCommands {
	entries: MenuEntry[];
	selected: number;
	line: SlashLine | null;
	dismissLine: () => void;
	// The box's keys while the menu is open; true when it took the key.
	handleKey: (event: KeyboardEvent) => boolean;
	// The text after picking an entry, or null when picking it ran it.
	pick: (entry: MenuEntry) => string | null;
	// Enter on the box: true when it was a Voice OS command (run here, not sent).
	runTyped: (text: string) => boolean;
	restart: () => void;
}

interface UseSlashCommandsParams {
	state: State;
	// The session the box talks to; null when none is on screen.
	sessionRef: string | null;
	text: string;
	setText: (text: string) => void;
	send: (message: ClientMessage) => void;
}

const failureLine = (stderr: string, fallback: string): SlashLine => ({
	text: stderr.trim().split('\n').at(-1) || fallback,
	isError: true,
});

export const useSlashCommands = ({
	state,
	sessionRef,
	text,
	setText,
	send,
}: UseSlashCommandsParams): SlashCommands => {
	const [selected, setSelected] = useState(0);
	const [line, setLine] = useState<SlashLine | null>(null);
	// Esc closes the menu until the text changes.
	const [closedFor, setClosedFor] = useState<string | null>(null);
	const typed = readTypedName(text);
	const entries =
		typed === null || closedFor === text
			? []
			: filterCommands(
					typed,
					sessionRef ? (state.sessions[sessionRef]?.commands ?? []) : [],
					Boolean(sessionRef),
				);
	const index = Math.min(selected, Math.max(entries.length - 1, 0));

	// A new filter starts at its best match.
	useEffect(() => setSelected(0), [typed]);
	const dispatch = (action: Action) => send({ type: 'action', action });

	const restart = (): void => {
		setLine({ text: "Restarting crew's server…" });
		void runCrew(LOCAL_MACHINE, { type: 'server_restart' });
	};

	const run = (action: SlashAction): void => {
		switch (action.kind) {
			case 'reload':
				if (sessionRef) {
					dispatch({
						type: 'reload_session',
						ref: sessionRef,
						kind: action.target,
						...(action.isForced ? { force: true as const } : {}),
					});
				}

				setLine(null);

				return;
			case 'model':
				if (sessionRef) {
					dispatch({ type: 'set_model', ref: sessionRef, model: action.model });
				}

				setLine(null);

				return;
			case 'stop':
				if (sessionRef) {
					dispatch({ type: 'interrupt', ref: sessionRef });
				}

				setLine(null);

				return;
			case 'mute':
				send({ type: 'mute', isMuted: action.isMuted });
				setLine({ text: action.isMuted ? 'Muted: only what needs you is said.' : 'Unmuted.' });

				return;
			case 'voice':
				dispatch({ type: 'set_voice_off', voiceOff: action.isOff });
				setLine({ text: action.isOff ? 'Voice is off.' : 'Voice is on.' });

				return;
			case 'update':
				setLine({ text: 'Updating crew on the main machine…' });
				void runCrew(LOCAL_MACHINE, { type: 'update' }).then((reply) =>
					setLine(
						isOk(reply)
							? {
									text: "crew is up to date on the main machine. Restart crew's server to run it; other machines follow on their next connect.",
									offersRestart: true,
								}
							: failureLine(reply.stderr, 'The update failed.'),
					),
				);

				return;
			case 'restart':
				restart();

				return;
			case 'usage':
				setLine({ text: action.text, isError: true });

				return;
		}
	};

	const pick = (entry: MenuEntry): string | null => {
		setSelected(0);

		if (entry.source === 'voice-os' && entry.isImmediate) {
			const action = parseVoiceOsCommand(`/${entry.name}`, Boolean(sessionRef));

			if (action) {
				run(action);
			}

			return null;
		}

		return `/${entry.name} `;
	};

	const handleKey = (event: KeyboardEvent): boolean => {
		if (entries.length === 0) {
			return false;
		}

		switch (event.key) {
			case 'ArrowDown':
				setSelected((index + 1) % entries.length);
				break;
			case 'ArrowUp':
				setSelected((index - 1 + entries.length) % entries.length);
				break;
			case 'Escape':
				setClosedFor(text);
				break;
			case 'Tab':
			case 'Enter': {
				if (event.key === 'Enter' && (event.shiftKey || event.nativeEvent.isComposing)) {
					return false;
				}

				const entry = entries[index];

				if (!entry) {
					return false;
				}

				setText(pick(entry) ?? '');
				break;
			}

			default:
				return false;
		}

		event.preventDefault();

		return true;
	};

	const runTyped = (typedText: string): boolean => {
		const action = parseVoiceOsCommand(typedText, Boolean(sessionRef));

		if (!action) {
			return false;
		}

		run(action);

		return true;
	};

	return {
		entries,
		selected: index,
		line,
		dismissLine: () => setLine(null),
		handleKey,
		pick,
		runTyped,
		restart,
	};
};

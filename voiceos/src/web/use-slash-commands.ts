// The "/" menu of a session's box and what Enter does with a Voice OS command. Claude's commands and
// skills are only filled in: the box sends them as words, as before.
import { type KeyboardEvent, useEffect, useState } from 'react';
import { LOCAL_MACHINE } from '../shared/machine-ref.js';
import type { ClientMessage, State } from '../shared/protocol.js';
import { runCrew } from './setup/api.js';
import {
	describeUpdate,
	filterCommands,
	type MenuEntry,
	parseVoiceOsCommand,
	planSlash,
	readTypedName,
	type SlashAction,
	type SlashLine,
} from './slash-commands.js';

export interface SlashCommands {
	entries: MenuEntry[];
	selected: number;
	line: SlashLine | null;
	dismissLine: () => void;
	// The box's keys while the menu is open; true when it took the key.
	handleKey: (event: KeyboardEvent) => boolean;
	// An entry picked: filled into the box, or run when it needs nothing more.
	choose: (entry: MenuEntry) => void;
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

	const run = (action: SlashAction): void => {
		const plan = planSlash(action, sessionRef);

		for (const message of plan.messages) {
			send(message);
		}

		setLine(plan.line);

		if (plan.crew === 'update') {
			void runCrew(LOCAL_MACHINE, { type: 'update' }).then((reply) =>
				setLine(describeUpdate(reply.code, reply.stderr)),
			);
		} else if (plan.crew === 'server_restart') {
			void runCrew(LOCAL_MACHINE, { type: 'server_restart' });
		}
	};

	const choose = (entry: MenuEntry): void => {
		setSelected(0);

		if (entry.source === 'voice-os' && entry.isImmediate) {
			const action = parseVoiceOsCommand(`/${entry.name}`, Boolean(sessionRef));

			setText('');

			if (action) {
				run(action);
			}

			return;
		}

		setText(`/${entry.name} `);
	};

	const handleKey = (event: KeyboardEvent): boolean => {
		const entry = entries[index];

		if (!entry) {
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
				choose(entry);
				break;
			case 'Enter':
				if (event.shiftKey || event.nativeEvent.isComposing) {
					return false;
				}

				choose(entry);
				break;
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
		choose,
		runTyped,
		restart: () => run({ kind: 'restart' }),
	};
};

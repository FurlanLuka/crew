// The box's "/" commands: the session's own (from Claude Code, sent to it as words) and Voice OS's,
// which run here instead. Pure, so the menu and what Enter does are tested without a page.
import type { SessionCommand } from '../shared/protocol.js';

export type VoiceOsCommandName =
	| 'reload-plugins'
	| 'reload-skills'
	| 'model'
	| 'stop'
	| 'mute'
	| 'unmute'
	| 'voice'
	| 'update'
	| 'restart';

interface VoiceOsCommand {
	name: VoiceOsCommandName;
	description: string;
	argumentHint: string;
	// Needs a session on screen (the Setup chat counts as one).
	isForSession: boolean;
	// Runs on Enter as picked; one with an argument is filled into the box instead.
	isArgumentRequired: boolean;
}

export const VOICE_OS_COMMANDS: VoiceOsCommand[] = [
	{
		name: 'reload-plugins',
		description: "Reload this session's plugins",
		argumentHint: '[force]',
		isForSession: true,
		isArgumentRequired: false,
	},
	{
		name: 'reload-skills',
		description: "Reload this session's skills",
		argumentHint: '',
		isForSession: true,
		isArgumentRequired: false,
	},
	{
		name: 'model',
		description: "Switch this session's model",
		argumentHint: '<opus | sonnet | haiku | model id>',
		isForSession: true,
		isArgumentRequired: true,
	},
	{
		name: 'stop',
		description: "Stop this session's turn",
		argumentHint: '',
		isForSession: true,
		isArgumentRequired: false,
	},
	{
		name: 'mute',
		description: "Quiet Voice OS's chatter",
		argumentHint: '',
		isForSession: false,
		isArgumentRequired: false,
	},
	{
		name: 'unmute',
		description: 'Let Voice OS talk again',
		argumentHint: '',
		isForSession: false,
		isArgumentRequired: false,
	},
	{
		name: 'voice',
		description: 'Turn voice off or on',
		argumentHint: '<off | on>',
		isForSession: false,
		isArgumentRequired: true,
	},
	{
		name: 'update',
		description: 'Install the latest crew on the main machine',
		argumentHint: '',
		isForSession: false,
		isArgumentRequired: false,
	},
	{
		name: 'restart',
		description: "Restart crew's server",
		argumentHint: '',
		isForSession: false,
		isArgumentRequired: false,
	},
];

export interface MenuEntry {
	name: string;
	description: string;
	argumentHint: string;
	source: 'session' | 'voice-os';
	// Picking it runs it at once instead of filling the box.
	isImmediate: boolean;
}

// What follows "/" while it is still being typed as a command name ("/rev" → "rev"); null once a
// space ends the name, or when the text is not a command at all.
export const readTypedName = (text: string): string | null => {
	const match = /^\/([^\s/]*)$/.exec(text);

	return match ? (match[1] ?? '').toLowerCase() : null;
};

const toEntry = (command: VoiceOsCommand): MenuEntry => ({
	name: command.name,
	description: command.description,
	argumentHint: command.argumentHint,
	source: 'voice-os',
	isImmediate: !command.isArgumentRequired,
});

// The menu for what is typed: names that start with it first, then names and descriptions that
// contain it; Voice OS's own after the session's. A Voice OS name hides the session's of that name.
export const filterCommands = (
	typed: string,
	sessionCommands: SessionCommand[],
	hasSession: boolean,
): MenuEntry[] => {
	const ours = VOICE_OS_COMMANDS.filter((command) => hasSession || !command.isForSession).map(
		toEntry,
	);
	const taken = new Set(ours.map((entry) => entry.name));
	const theirs: MenuEntry[] = sessionCommands
		.filter((command) => !taken.has(command.name))
		.map((command) => ({ ...command, source: 'session', isImmediate: false }));
	const rank = (entry: MenuEntry): number =>
		entry.name.toLowerCase().startsWith(typed)
			? 0
			: entry.name.toLowerCase().includes(typed) || entry.description.toLowerCase().includes(typed)
				? 1
				: 2;
	const matching = (entries: MenuEntry[]) =>
		entries
			.map((entry) => ({ entry, rank: rank(entry) }))
			.filter(({ rank: score }) => score < 2)
			.sort((first, second) => first.rank - second.rank)
			.map(({ entry }) => entry);

	return [...matching(theirs), ...matching(ours)];
};

export type SlashAction =
	| { kind: 'reload'; target: 'plugins' | 'skills'; isForced: boolean }
	| { kind: 'model'; model: string }
	| { kind: 'stop' }
	| { kind: 'mute'; isMuted: boolean }
	| { kind: 'voice'; isOff: boolean }
	| { kind: 'update' }
	| { kind: 'restart' }
	// Typed wrong: what to say instead of sending it anywhere.
	| { kind: 'usage'; text: string };

// A box's text as a Voice OS command, or null: anything else (Claude's commands and skills, unknown
// "/words", plain words) goes to the session as typed.
export const parseVoiceOsCommand = (text: string, hasSession: boolean): SlashAction | null => {
	const match = /^\/([a-z-]+)(?:\s+(.*))?$/s.exec(text.trim());
	const command = VOICE_OS_COMMANDS.find((entry) => entry.name === match?.[1]);

	if (!match || !command) {
		return null;
	}

	if (command.isForSession && !hasSession) {
		return { kind: 'usage', text: `Open a session to use /${command.name}.` };
	}

	const argument = (match[2] ?? '').trim();

	switch (command.name) {
		case 'reload-plugins':
			return { kind: 'reload', target: 'plugins', isForced: argument === 'force' };
		case 'reload-skills':
			return { kind: 'reload', target: 'skills', isForced: false };
		case 'model':
			return /^[\w.\-[\]]{1,80}$/.test(argument)
				? { kind: 'model', model: argument }
				: { kind: 'usage', text: 'Say which model: /model opus, /model sonnet or a model id.' };
		case 'stop':
			return { kind: 'stop' };
		case 'mute':
			return { kind: 'mute', isMuted: true };
		case 'unmute':
			return { kind: 'mute', isMuted: false };
		case 'voice':
			return argument === 'off' || argument === 'on'
				? { kind: 'voice', isOff: argument === 'off' }
				: { kind: 'usage', text: '/voice off or /voice on.' };
		case 'update':
			return { kind: 'update' };
		case 'restart':
			return { kind: 'restart' };
	}
};

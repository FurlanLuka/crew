// The box's "/" commands: the session's own (from Claude Code, sent to it as words) and Voice OS's,
// which run here instead. Pure, so the menu and what Enter does are tested without a page.
import { z } from 'zod';
import {
	MODEL_ID_PATTERN,
	type ClientMessage,
	type SessionCommand,
	type SessionMode,
} from '../shared/protocol.js';
import { isSessionMode } from '../shared/modes.js';

export type VoiceOsCommandName =
	| 'reload-plugins'
	| 'reload-skills'
	| 'model'
	| 'mode'
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
		name: 'mode',
		description: "Switch this session's permission mode",
		argumentHint: '<auto | plan | ask | skip>',
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

// Where the menu's highlight starts: on the command named exactly ("/update" is update, not a skill
// called update-config), else on the best match.
export const pickStart = (entries: MenuEntry[], typed: string): number =>
	Math.max(
		entries.findIndex((entry) => entry.name.toLowerCase() === typed),
		0,
	);

export type SlashAction =
	| { kind: 'reload'; target: 'plugins' | 'skills'; isForced: boolean }
	| { kind: 'model'; model: string }
	| { kind: 'mode'; mode: SessionMode }
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
			return MODEL_ID_PATTERN.test(argument)
				? { kind: 'model', model: argument }
				: { kind: 'usage', text: 'Say which model: /model opus, /model sonnet or a model id.' };
		case 'mode':
			return isSessionMode(argument)
				? { kind: 'mode', mode: argument }
				: { kind: 'usage', text: 'Say which mode: /mode auto, plan, ask or skip.' };
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

// What a Voice OS command said back, under the box; offersRestart: the restart an update needs.
export interface SlashLine {
	text: string;
	isError?: true;
	offersRestart?: true;
}

export interface SlashPlan {
	messages: ClientMessage[];
	line: SlashLine | null;
	// crew to run on the main, its answer said when it comes.
	crew: 'update' | 'server_restart' | null;
}

const plan = (
	messages: ClientMessage[],
	line: SlashLine | null = null,
	crew: SlashPlan['crew'] = null,
): SlashPlan => ({ messages, line, crew });

// What a Voice OS command does from the page: the messages it sends, the line it shows, the crew it runs.
export const planSlash = (action: SlashAction, sessionRef: string | null): SlashPlan => {
	const forSession = (build: (ref: string) => ClientMessage): ClientMessage[] =>
		sessionRef ? [build(sessionRef)] : [];

	switch (action.kind) {
		case 'reload':
			return plan(
				forSession((ref) => ({
					type: 'action',
					action: {
						type: 'reload_session',
						ref,
						kind: action.target,
						...(action.isForced ? { force: true as const } : {}),
					},
				})),
			);
		case 'model':
			return plan(
				forSession((ref) => ({
					type: 'action',
					action: { type: 'set_model', ref, model: action.model },
				})),
			);
		case 'mode':
			return plan(
				forSession((ref) => ({
					type: 'action',
					action: { type: 'set_mode', ref, mode: action.mode, by: 'page' },
				})),
			);
		case 'stop':
			return plan(forSession((ref) => ({ type: 'action', action: { type: 'interrupt', ref } })));
		case 'mute':
			return plan([{ type: 'mute', isMuted: action.isMuted }], {
				text: action.isMuted ? 'Muted: only what needs you is said.' : 'Unmuted.',
			});
		case 'voice':
			return plan([{ type: 'action', action: { type: 'set_voice_off', voiceOff: action.isOff } }], {
				text: action.isOff ? 'Voice is off.' : 'Voice is on.',
			});
		case 'update':
			return plan([], { text: 'Updating crew on the main machine…' }, 'update');
		case 'restart':
			return plan([], { text: "Restarting crew's server…" }, 'server_restart');
		case 'usage':
			return plan([], { text: action.text, isError: true });
	}
};

const updateSchema = z.object({ to: z.string(), updated: z.boolean().optional() });

// crew update --json's answer: a new release installed (a restart runs it), already current
// (nothing to restart), or crew's own last line when it failed.
export const describeUpdate = (code: number, json: unknown, stderr: string): SlashLine => {
	const result = updateSchema.safeParse(json);

	if (code !== 0 || !result.success) {
		return { text: stderr.trim().split('\n').at(-1) || 'The update failed.', isError: true };
	}

	return result.data.updated
		? {
				text: `crew v${result.data.to} is installed on the main machine. Restart crew's server to run it; other machines follow on their next connect.`,
				offersRestart: true,
			}
		: { text: `crew is already up to date (v${result.data.to}) on the main machine.` };
};

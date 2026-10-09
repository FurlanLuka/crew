import { describe, expect, it } from 'bun:test';
import {
	describeUpdate,
	filterCommands,
	parseVoiceOsCommand,
	pickStart,
	planSlash,
	readTypedName,
	type SlashAction,
	type SlashPlan,
} from './slash-commands.js';

const SESSION = [
	{ name: 'review', description: 'Review a pull request', argumentHint: '<pr>' },
	{ name: 'release-notes', description: 'Write the notes', argumentHint: '' },
	// A session command Voice OS's own of that name hides.
	{ name: 'model', description: "Claude's model picker", argumentHint: '' },
];

describe('readTypedName', () => {
	it.each([
		['/', ''],
		['/Rev', 'rev'],
		['/review ', null],
		['hi /review', null],
		['', null],
	])('%p → %p', (text, typed) => expect(readTypedName(text)).toBe(typed));
});

describe('filterCommands', () => {
	const names = (typed: string, hasSession = true) =>
		filterCommands(typed, SESSION, hasSession).map((entry) => `${entry.source}:${entry.name}`);

	it("everything for a bare /: the session's first, then Voice OS's", () => {
		const all = names('');

		expect(all.slice(0, 2)).toEqual(['session:review', 'session:release-notes']);
		expect(all).toContain('voice-os:update');
		expect(all).not.toContain('session:model');
	});

	it('names that start with it first, then names or descriptions that contain it', () => {
		expect(names('re')).toEqual([
			'session:review',
			'session:release-notes',
			'voice-os:reload-plugins',
			'voice-os:reload-skills',
			'voice-os:restart',
			'voice-os:update',
		]);
	});

	it('no session on screen: only the Voice OS commands that need none', () => {
		expect(filterCommands('', [], false).map((entry) => entry.name)).toEqual([
			'mute',
			'unmute',
			'voice',
			'update',
			'restart',
		]);
	});
});

describe('parseVoiceOsCommand', () => {
	it.each([
		['/reload-plugins', { kind: 'reload', target: 'plugins', isForced: false }],
		['/reload-plugins force', { kind: 'reload', target: 'plugins', isForced: true }],
		['/reload-skills', { kind: 'reload', target: 'skills', isForced: false }],
		['/model claude-opus-5-5[1m]', { kind: 'model', model: 'claude-opus-5-5[1m]' }],
		[
			'/model',
			{ kind: 'usage', text: 'Say which model: /model opus, /model sonnet or a model id.' },
		],
		['/mode plan', { kind: 'mode', mode: 'plan' }],
		['/mode skip', { kind: 'mode', mode: 'skip' }],
		['/mode', { kind: 'usage', text: 'Say which mode: /mode auto, plan, ask or skip.' }],
		['/mode bypass', { kind: 'usage', text: 'Say which mode: /mode auto, plan, ask or skip.' }],
		['/stop', { kind: 'stop' }],
		['/mute', { kind: 'mute', isMuted: true }],
		['/unmute', { kind: 'mute', isMuted: false }],
		['/voice off', { kind: 'voice', isOff: true }],
		['/voice loud', { kind: 'usage', text: '/voice off or /voice on.' }],
		['/update', { kind: 'update' }],
		['/restart', { kind: 'restart' }],
	])('%p → %p', (text, action) => expect(parseVoiceOsCommand(text, true)).toEqual(action as never));

	it("Claude's commands, skills, unknown words and plain text are not Voice OS's", () => {
		for (const text of ['/review 12', '/compact', '/whatever', 'stop the build', 'go /stop']) {
			expect(parseVoiceOsCommand(text, true)).toBeNull();
		}
	});

	it('a session command with no session on screen says so', () => {
		expect(parseVoiceOsCommand('/stop', false)).toEqual({
			kind: 'usage',
			text: 'Open a session to use /stop.',
		});
	});
});

describe('planSlash', () => {
	const REF = 'store/main';
	const act = (action: object) => ({ type: 'action', action });

	it.each<[SlashAction, string | null, SlashPlan]>([
		[
			{ kind: 'reload', target: 'plugins', isForced: true },
			REF,
			{
				messages: [
					act({ type: 'reload_session', ref: REF, kind: 'plugins', force: true }),
				] as never,
				line: null,
				crew: null,
			},
		],
		[
			{ kind: 'reload', target: 'skills', isForced: false },
			REF,
			{
				messages: [act({ type: 'reload_session', ref: REF, kind: 'skills' })] as never,
				line: null,
				crew: null,
			},
		],
		[
			{ kind: 'model', model: 'opus' },
			REF,
			{
				messages: [act({ type: 'set_model', ref: REF, model: 'opus' })] as never,
				line: null,
				crew: null,
			},
		],
		[
			{ kind: 'mode', mode: 'ask' },
			REF,
			{
				messages: [act({ type: 'set_mode', ref: REF, mode: 'ask', by: 'page' })] as never,
				line: null,
				crew: null,
			},
		],
		[
			{ kind: 'stop' },
			REF,
			{ messages: [act({ type: 'interrupt', ref: REF })] as never, line: null, crew: null },
		],
		[{ kind: 'stop' }, null, { messages: [], line: null, crew: null }],
		[
			{ kind: 'mute', isMuted: true },
			null,
			{
				messages: [{ type: 'mute', isMuted: true }],
				line: { text: 'Muted: only what needs you is said.' },
				crew: null,
			},
		],
		[
			{ kind: 'mute', isMuted: false },
			null,
			{ messages: [{ type: 'mute', isMuted: false }], line: { text: 'Unmuted.' }, crew: null },
		],
		[
			{ kind: 'voice', isOff: true },
			null,
			{
				messages: [act({ type: 'set_voice_off', voiceOff: true })] as never,
				line: { text: 'Voice is off.' },
				crew: null,
			},
		],
		[
			{ kind: 'update' },
			REF,
			{ messages: [], line: { text: 'Updating crew on the main machine…' }, crew: 'update' },
		],
		[
			{ kind: 'restart' },
			null,
			{ messages: [], line: { text: "Restarting crew's server…" }, crew: 'server_restart' },
		],
		[
			{ kind: 'usage', text: 'Nope.' },
			REF,
			{ messages: [], line: { text: 'Nope.', isError: true }, crew: null },
		],
	])('%p on %p', (action, ref, expected) => expect(planSlash(action, ref)).toStrictEqual(expected));
});

describe('describeUpdate', () => {
	it("installed → a restart offered; already current → none; failed → crew's last line", () => {
		expect(describeUpdate(0, { from: '6.4.0', to: '6.5.0', updated: true }, '')).toEqual({
			text: "crew v6.5.0 is installed on the main machine. Restart crew's server to run it; other machines follow on their next connect.",
			offersRestart: true,
		});
		expect(describeUpdate(0, { from: '6.4.0', to: '6.4.0' }, '')).toEqual({
			text: 'crew is already up to date (v6.4.0) on the main machine.',
		});
		expect(describeUpdate(1, undefined, 'checking…\nerror: offline\n')).toEqual({
			text: 'error: offline',
			isError: true,
		});
		expect(describeUpdate(0, 'not json', '')).toEqual({
			text: 'The update failed.',
			isError: true,
		});
	});
});

describe('pickStart', () => {
	it('the command named exactly, wherever it is; else the first', () => {
		const withSkill = [
			{ name: 'update-config', description: 'Configure', argumentHint: '' },
			...SESSION,
		];
		const entries = filterCommands('update', withSkill, true);

		expect(entries[0]?.name).toBe('update-config');
		expect(entries[pickStart(entries, 'update')]?.name).toBe('update');
		expect(pickStart(filterCommands('upd', withSkill, true), 'upd')).toBe(0);
	});
});

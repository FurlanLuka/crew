import { describe, expect, it } from 'bun:test';
import { filterCommands, parseVoiceOsCommand, readTypedName } from './slash-commands.js';

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

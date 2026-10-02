import { describe, expect, it } from 'bun:test';
import type { DevServer } from '../shared/protocol.js';
import { createInitialState } from '../state/reducer.js';
import { buildDiscordNote, buildSituationNote, VOICE_OS_CONTEXT } from './voice-context.js';

const createServer = (
	name: string,
	state: DevServer['state'],
	detail: string | null = null,
): DevServer => ({ name, port: 3000, url: null, state, detail });

describe('buildSituationNote', () => {
	it('down servers with their detail, then what the developer was saying', () => {
		const note = buildSituationNote({
			servers: [
				createServer('api', 'died', 'exit 1: missing DATABASE_URL'),
				createServer('web', 'running'),
				createServer('worker', 'not listening'),
				createServer('jobs', 'starting'),
			],
			recent: ['Restart the dev servers?', 'Why were they failing?'],
		});
		expect(note).toBe(
			'(Voice OS, not the developer — context for the message below: dev servers down: api died (exit 1: missing DATABASE_URL); worker not listening. ' +
				'the developer was just saying to Voice OS: "Restart the dev servers?", "Why were they failing?".)',
		);
	});

	it('nothing down and nothing said → no note', () =>
		expect(
			buildSituationNote({
				servers: [createServer('web', 'running'), createServer('jobs', 'starting')],
				recent: [],
			}),
		).toBe(''));

	it('only the last few things said, long ones cut', () => {
		const note = buildSituationNote({
			servers: [],
			recent: ['one', 'two', 'three', 'four', 'five', 'x'.repeat(300)],
		});
		expect(note).not.toContain('"one"');
		expect(note).not.toContain('"two"');
		expect(note).toContain('"three"');
		expect(note).toContain(`${'x'.repeat(200)}…`);
	});

	it('quotes in what was said are kept as said', () =>
		expect(buildSituationNote({ servers: [], recent: ['say "hi"'] })).toContain('"say "hi""'));
});

describe('VOICE_OS_CONTEXT', () => {
	it('sessions write their own spoken lines, with substance, and ask one question per call', () => {
		expect(VOICE_OS_CONTEXT).toContain('<spoken>…</spoken>` as its very first line');
		expect(VOICE_OS_CONTEXT).toContain('any risk or catch they must know');
		expect(VOICE_OS_CONTEXT).toContain('never a bare verdict');
		expect(VOICE_OS_CONTEXT).toContain('<spoken asks>');
		expect(VOICE_OS_CONTEXT).toContain('also give them the major checkpoints');
		expect(VOICE_OS_CONTEXT).toContain('never restate what your previous one said');
		expect(VOICE_OS_CONTEXT).toContain('a tag says only what it adds');
		expect(VOICE_OS_CONTEXT).toContain('never to say you are still waiting');
		expect(VOICE_OS_CONTEXT).toContain('never for routine steps, files or commands');
		expect(VOICE_OS_CONTEXT).toContain('written before your first tool call, skill or file read');
		expect(VOICE_OS_CONTEXT).toContain('as soon as you reach it, before the next tool call');
		expect(VOICE_OS_CONTEXT).toContain('Put one question in each call');
	});

	it('words arriving mid-work → a short tag saying what comes next, before the next tool call', () => {
		expect(VOICE_OS_CONTEXT).toContain(
			'an interruption, a follow-up, an answer, a withdrawn question — open your next message with a short tag saying what you do next, before the next tool call',
		);
	});

	it('logs, debug notes and notes → the crew commands, never file paths', () => {
		expect(VOICE_OS_CONTEXT).toContain('`crew server logs --since=10m`');
		expect(VOICE_OS_CONTEXT).toContain('`crew server debug-notes`');
		expect(VOICE_OS_CONTEXT).toContain('`crew server notes <workspace>`');
		expect(VOICE_OS_CONTEXT).not.toContain('.crew/voiceos');
	});

	it('voice cues → one optional allowed tag inside a full sentence, never SSML', () => {
		expect(VOICE_OS_CONTEXT).toContain(
			'A line may carry one voice cue in brackets, only where it fits and only inside a full sentence',
		);
		expect(VOICE_OS_CONTEXT).toContain('[laughs], [chuckles], [sighs], [pause], [warm]');
		expect(VOICE_OS_CONTEXT).toContain('never SSML or other markup, which is read aloud');
	});
});

describe('buildDiscordNote', () => {
	const presence = {
		isConnected: true,
		isHearing: true,
		channelName: 'Voice OS',
		mode: 'hands-free',
	} as const;

	it('the developer in the voice channel → told they hear but cannot see the page', () =>
		expect(
			buildDiscordNote({ ...createInitialState(), discord: { ...presence, isOwnerIn: true } }),
		).toContain('Discord voice channel, away from the page'));

	it('not in it → no note', () => {
		expect(
			buildDiscordNote({ ...createInitialState(), discord: { ...presence, isOwnerIn: false } }),
		).toBeUndefined();
		expect(buildDiscordNote(createInitialState())).toBeUndefined();
	});
});

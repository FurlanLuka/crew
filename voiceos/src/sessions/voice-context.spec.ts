import { describe, expect, it } from 'bun:test';
import type { DevServer } from '../shared/protocol.js';
import { buildSituationNote } from './voice-context.js';

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

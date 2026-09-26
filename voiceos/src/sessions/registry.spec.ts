import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetSession, loadRegistry, markBriefed, recordSession } from './registry.js';

const createTmpFile = () => join(mkdtempSync(join(tmpdir(), 'voiceos-reg-')), 'sessions.json');

describe('registry', () => {
	it('missing file → empty', () => expect(loadRegistry(createTmpFile())).toEqual({}));

	it('corrupt file → empty, no throw', () => {
		const file = createTmpFile();
		writeFileSync(file, '{not json');
		expect(loadRegistry(file)).toEqual({});
	});

	it('wrong shape → only valid records kept', () => {
		const file = createTmpFile();
		writeFileSync(
			file,
			JSON.stringify({ 'store/main': { sessionId: 'abc' }, bad: { sessionId: 3 }, arr: [] }),
		);
		expect(Object.keys(loadRegistry(file))).toEqual(['store/main']);
	});

	it('record then load → round trip; no temp file left behind', () => {
		const file = createTmpFile();
		recordSession({
			file,
			ref: 'store/main',
			sessionId: 'id-1',
			now: new Date('2026-09-25T00:00:00Z'),
		});

		expect(loadRegistry(file)).toEqual({
			'store/main': { sessionId: 'id-1', updatedAt: '2026-09-25T00:00:00.000Z' },
		});
		expect(readdirSync(join(file, '..'))).toEqual(['sessions.json']);
	});

	it('forget → removes only that ref', () => {
		const file = createTmpFile();
		recordSession({ file, ref: 'store/main', sessionId: 'id-1' });
		recordSession({ file, ref: 'store/wrk1', sessionId: 'id-2' });
		forgetSession(file, 'store/main');

		expect(Object.keys(loadRegistry(file))).toEqual(['store/wrk1']);
	});

	it('a new session records the briefing its prompt carries; the same session resumed keeps what it had', () => {
		const file = createTmpFile();
		recordSession({ file, ref: 'store/main', sessionId: 'id-1', briefing: 'v1' });
		expect(loadRegistry(file)['store/main']?.briefing).toBe('v1');

		recordSession({ file, ref: 'store/main', sessionId: 'id-1', briefing: 'v2' });
		expect(loadRegistry(file)['store/main']?.briefing).toBe('v1');

		recordSession({ file, ref: 'store/main', sessionId: 'id-2', briefing: 'v2' });
		expect(loadRegistry(file)['store/main']?.briefing).toBe('v2');
	});

	it('markBriefed → the version recorded for that session only', () => {
		const file = createTmpFile();
		recordSession({ file, ref: 'store/main', sessionId: 'id-1' });
		markBriefed(file, 'store/main', 'v3');
		markBriefed(file, 'nope/main', 'v3');
		expect(loadRegistry(file)).toMatchObject({
			'store/main': { sessionId: 'id-1', briefing: 'v3' },
		});
		expect(loadRegistry(file)['nope/main']).toBeUndefined();
	});
});

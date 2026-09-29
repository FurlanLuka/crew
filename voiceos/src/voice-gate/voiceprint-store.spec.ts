import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	deleteVoiceprint,
	loadVoiceprint,
	parseVoiceprint,
	saveVoiceprint,
	VOICEPRINT_LENGTH,
	type VoiceprintRecord,
} from './voiceprint-store.js';

const PACK = 'voice-gate-pack-1';

let dir: string;
let file: string;

const vector = (first: number): Float32Array => {
	const values = new Float32Array(VOICEPRINT_LENGTH);

	values[0] = first;
	values[1] = 1;

	return values;
};

const record = (): VoiceprintRecord => ({
	packId: PACK,
	voiceprint: vector(0.5),
	enrolled: vector(0.25),
	recentScores: [0.64, 0.71],
	turns: 2,
	updatedAt: '2026-09-29T06:00:00.000Z',
});

const stored = (overrides: Record<string, unknown>): string =>
	JSON.stringify({
		version: 1,
		packId: PACK,
		voiceprint: [...vector(0.5)],
		enrolled: [...vector(0.25)],
		recentScores: [0.7],
		turns: 1,
		updatedAt: 'now',
		...overrides,
	});

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'voiceprint-'));
	file = join(dir, 'voiceos', 'voiceprint.json');
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('saveVoiceprint / loadVoiceprint', () => {
	it('saved → loads back the same voice, its folder made, the file readable by its owner only', () => {
		saveVoiceprint(file, record());

		const loaded = loadVoiceprint(file, PACK);

		expect(loaded.kind).toBe('found');

		if (loaded.kind === 'found') {
			expect([...loaded.record.voiceprint]).toEqual([...record().voiceprint]);
			expect([...loaded.record.enrolled]).toEqual([...record().enrolled]);
			expect(loaded.record.recentScores).toEqual([0.64, 0.71]);
			expect(loaded.record.turns).toBe(2);
		}

		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(readdirSync(join(dir, 'voiceos'))).toEqual(['voiceprint.json']);
	});

	it('the file holds numbers about the voice, never more than that', () => {
		saveVoiceprint(file, record());

		expect(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort()).toEqual([
			'enrolled',
			'packId',
			'recentScores',
			'turns',
			'updatedAt',
			'version',
			'voiceprint',
		]);
	});

	it('a temp file left by a crash → never read as the voiceprint', () => {
		saveVoiceprint(file, record());
		writeFileSync(`${file}.123-abcd.tmp`, stored({ turns: 99 }));

		const loaded = loadVoiceprint(file, PACK);

		expect(loaded.kind === 'found' && loaded.record.turns).toBe(2);
	});

	it('the rename failing (a folder where the file goes) → an error, no temp file left', () => {
		mkdirSync(file, { recursive: true });

		expect(() => saveVoiceprint(file, record())).toThrow();
		expect(readdirSync(join(dir, 'voiceos'))).toEqual(['voiceprint.json']);
	});

	it('a file that cannot be read → ignored with the reason, not taken for no voice', () => {
		mkdirSync(file, { recursive: true });

		const loaded = loadVoiceprint(file, PACK);

		expect(loaded.kind === 'ignored' && loaded.reason).toContain('unreadable');
	});

	it('nothing saved → none', () => {
		expect(loadVoiceprint(file, PACK)).toEqual({ kind: 'none' });
	});

	it('deleted, or deleting what is not there → gone, no error', () => {
		saveVoiceprint(file, record());
		deleteVoiceprint(file);
		deleteVoiceprint(file);

		expect(loadVoiceprint(file, PACK)).toEqual({ kind: 'none' });
	});
});

describe('parseVoiceprint', () => {
	const cases: [string, string, string][] = [
		['learned with other models', stored({ packId: 'voice-gate-pack-2' }), 'learned with'],
		['a newer format', stored({ version: 2 }), 'version 2'],
		['a wrong length', stored({ voiceprint: [1, 2, 3] }), 'not a voiceprint'],
		[
			'a NaN (written as null)',
			stored({ voiceprint: [null, ...[...vector(1)].slice(1)] }),
			'not a voiceprint',
		],
		[
			'a zero vector',
			stored({ enrolled: new Array(VOICEPRINT_LENGTH).fill(0) }),
			'not a voiceprint',
		],
		['turns missing', stored({ turns: undefined }), 'bad learning record'],
		['negative turns', stored({ turns: -1 }), 'bad learning record'],
		['scores not numbers', stored({ recentScores: ['x'] }), 'bad learning record'],
		['not JSON', '{', 'not JSON'],
	];

	for (const [name, text, reason] of cases) {
		it(`${name} → ignored, with the reason`, () => {
			const parsed = parseVoiceprint(text, PACK);

			expect(parsed.kind).toBe('ignored');
			expect(parsed.kind === 'ignored' && parsed.reason).toContain(reason);
		});
	}

	it('an ignored file → left where it is', () => {
		saveVoiceprint(file, { ...record(), packId: 'voice-gate-pack-2' });

		expect(loadVoiceprint(file, PACK).kind).toBe('ignored');
		expect(readdirSync(join(dir, 'voiceos'))).toEqual(['voiceprint.json']);
	});
});

import { afterEach, describe, expect, it } from 'bun:test';
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureLog, createLogger } from './log.js';

const log = createLogger('test');

afterEach(() => {
	configureLog({ quiet: true });
});

const newFile = (): string => join(mkdtempSync(join(tmpdir(), 'voiceos-log-')), 'voiceos.log');

const read = (file: string): string => (existsSync(file) ? readFileSync(file, 'utf8') : '');

const countLines = (file: string): number => read(file).split('\n').filter(Boolean).length;

// Every line of `log.info('line')` has the same length: the timestamp is fixed-width.
const lineBytes = (): number => {
	const file = newFile();

	configureLog({ file, quiet: true });
	log.info('line');

	return statSync(file).size;
};

const start = (file: string, maxBytes: number, keep = 5): void => {
	configureLog({ file, quiet: true, maxBytes, keep });
};

describe('log rotation', () => {
	it('no file at configure → created on the first line', () => {
		const file = join(mkdtempSync(join(tmpdir(), 'voiceos-log-')), 'logs', 'voiceos.log');

		start(file, 1_000);
		log.info('line');

		expect(countLines(file)).toBe(1);
	});

	it('two lines exactly at the limit → one file', () => {
		const file = newFile();

		start(file, lineBytes() * 2);
		log.info('line');
		log.info('line');

		expect({ live: countLines(file), rotated: existsSync(`${file}.1`) }).toEqual({
			live: 2,
			rotated: false,
		});
	});

	it('one byte over the limit → the first line rotated to .1', () => {
		const file = newFile();

		start(file, lineBytes() * 2 - 1);
		log.info('line');
		log.info('line');

		expect({ live: countLines(file), rotated: countLines(`${file}.1`) }).toEqual({
			live: 1,
			rotated: 1,
		});
	});

	it('a line bigger than the limit → into the empty file; the next line rotates once', () => {
		const file = newFile();

		start(file, 10);
		log.info('first');
		log.info('second');

		expect(read(`${file}.1`)).toContain('"first"');
		expect(read(file)).toContain('"second"');
		expect(existsSync(`${file}.2`)).toBe(false);
	});

	it('gaps in the numbered files → each shifts up one, the oldest past keep deleted', () => {
		const file = newFile();

		writeFileSync(file, 'live\n');
		writeFileSync(`${file}.2`, 'two\n');
		writeFileSync(`${file}.4`, 'four\n');
		writeFileSync(`${file}.5`, 'five\n');
		start(file, 5);
		log.info('line');

		expect([1, 2, 3, 4, 5].map((index) => read(`${file}.${index}`))).toEqual([
			'live\n',
			'',
			'two\n',
			'',
			'four\n',
		]);
		expect(existsSync(`${file}.6`)).toBe(false);
	});

	it('the file deleted while running → written again from nothing, no rotation', () => {
		const file = newFile();

		start(file, lineBytes() * 2);
		log.info('line');
		log.info('line');
		rmSync(file);
		log.info('line');

		expect({ live: countLines(file), rotated: existsSync(`${file}.1`) }).toEqual({
			live: 1,
			rotated: false,
		});
	});

	it('a rename that fails → no throw, appending continues', () => {
		const file = newFile();
		const dir = join(file, '..');

		writeFileSync(file, 'x'.repeat(100));
		start(file, 50);
		chmodSync(dir, 0o555);

		try {
			expect(() => log.info('line')).not.toThrow();
		} finally {
			chmodSync(dir, 0o755);
		}

		expect(read(file)).toContain('"line"');
		expect(existsSync(`${file}.1`)).toBe(false);
	});

	it('an oversized file present at start → rotated on the first line', () => {
		const file = newFile();

		writeFileSync(file, `${'x'.repeat(1_000)}\n`);
		start(file, 500);
		log.info('line');

		expect(statSync(`${file}.1`).size).toBe(1_001);
		expect(countLines(file)).toBe(1);
	});

	it("a field named ts → the log's own time stays, as the first key", () => {
		const file = newFile();

		start(file, 1_000);
		log.info('line', { ts: 'from a field', other: 1 });

		const line = read(file);
		const parsed = JSON.parse(line) as { ts: string; other: number };

		expect(line.startsWith('{"ts":')).toBe(true);
		expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(parsed.other).toBe(1);
	});

	it('another writer rotated the file behind this one → no second rotation', () => {
		const file = newFile();
		const bytes = lineBytes();

		start(file, bytes * 2);
		log.info('line');
		log.info('line');
		// A hand-run cockpit on the same file rotated it; this logger still counts two lines.
		renameSync(file, `${file}.1`);
		log.info('line');

		expect({
			live: countLines(file),
			first: countLines(`${file}.1`),
			second: existsSync(`${file}.2`),
		}).toEqual({ live: 1, first: 2, second: false });
	});
});

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogFields = Record<string, unknown>;

// crew voice logs reads `<file>`, `<file>.1` … `<file>.5`, newest first: keep the two in step.
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_KEEP = 5;

// Process-wide log settings, set by configureLog at startup.
let logFile: string | null = null;
let isQuiet = false;
let maxBytes = DEFAULT_MAX_BYTES;
let keep = DEFAULT_KEEP;
// Tracked in memory so an append costs no stat; checked against the disk only near the cap.
let size = 0;

interface ConfigureLogParams {
	file?: string | null;
	quiet?: boolean;
	maxBytes?: number;
	// Rotated files kept beside the live one.
	keep?: number;
}

const readSize = (file: string): number => {
	try {
		return statSync(file).size;
	} catch {
		return 0;
	}
};

export const configureLog = (options: ConfigureLogParams): void => {
	logFile = options.file ?? null;
	isQuiet = options.quiet ?? false;
	maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	keep = options.keep ?? DEFAULT_KEEP;

	if (logFile) {
		mkdirSync(dirname(logFile), { recursive: true });
		size = readSize(logFile);
	}
};

const shiftQuietly = (from: string, to: string): void => {
	try {
		renameSync(from, to);
	} catch {
		// A gap in the numbered files: nothing to move.
	}
};

const rotate = (file: string): void => {
	rmSync(`${file}.${keep}`, { force: true });

	for (let index = keep - 1; index >= 1; index--) {
		shiftQuietly(`${file}.${index}`, `${file}.${index + 1}`);
	}

	renameSync(file, `${file}.1`);
};

// Near the cap the disk decides, not the count: another writer (a hand-run cockpit on the same file)
// may have rotated it already, and a deleted file starts again from nothing.
const makeRoom = (file: string, bytes: number): void => {
	size = readSize(file);

	// An empty file takes even a line bigger than the cap: rotating it would only move nothing.
	if (size === 0 || size + bytes <= maxBytes) {
		return;
	}

	try {
		rotate(file);
		size = 0;
	} catch {
		// A failed rename leaves the file where it was; appending simply continues.
	}
};

const append = (file: string, text: string): void => {
	const bytes = Buffer.byteLength(text);

	if (size + bytes > maxBytes) {
		makeRoom(file, bytes);
	}

	try {
		appendFileSync(file, text);
		size += bytes;
	} catch {
		// A full disk must not take the server down; stdout still has the line.
	}
};

interface LogParams {
	level: LogLevel;
	category: string;
	message: string;
	fields?: LogFields;
}

export const log = ({ level, category, message, fields = {} }: LogParams): void => {
	// One JSON object per line, so jq can follow one action across gateway, worker and speech. `ts`
	// stays the first key: crew voice logs compares the line's prefix before decoding it.
	const line = JSON.stringify({
		ts: new Date().toISOString(),
		level,
		cat: category,
		msg: message,
		...fields,
	});

	if (!isQuiet) {
		(level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
	}

	if (logFile) {
		append(logFile, `${line}\n`);
	}
};

export const createLogger = (category: string) => ({
	debug: (message: string, fields?: LogFields) =>
		log({ level: 'debug', category, message, fields }),
	info: (message: string, fields?: LogFields) => log({ level: 'info', category, message, fields }),
	warn: (message: string, fields?: LogFields) => log({ level: 'warn', category, message, fields }),
	error: (message: string, fields?: LogFields) =>
		log({ level: 'error', category, message, fields }),
});

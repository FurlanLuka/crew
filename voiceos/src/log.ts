import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogFields = Record<string, unknown>;

// Process-wide log settings, set by configureLog at startup.
let logFile: string | null = null;
let isQuiet = false;

interface ConfigureLogParams {
	file?: string | null;
	quiet?: boolean;
}

export const configureLog = (options: ConfigureLogParams): void => {
	logFile = options.file ?? null;
	isQuiet = options.quiet ?? false;

	if (logFile) {
		mkdirSync(dirname(logFile), { recursive: true });
	}
};

interface LogParams {
	level: LogLevel;
	category: string;
	message: string;
	fields?: LogFields;
}

export const log = ({ level, category, message, fields = {} }: LogParams): void => {
	// One JSON object per line, so jq can follow one action across gateway, worker and speech.
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

	if (!logFile) {
		return;
	}

	try {
		appendFileSync(logFile, `${line}\n`);
	} catch {
		// A full disk must not take the server down; stdout still has the line.
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

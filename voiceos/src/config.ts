import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface Paths {
	home: string;
	crewDir: string;
	voiceDir: string;
	tokenFile: string;
	sessionsFile: string;
	stateFile: string;
	logFile: string;
	debugNotesFile: string;
	journalDir: string;
	debugAudioDir: string;
	topicsFile: string;
	keysDir: string;
}

export interface Keys {
	anthropic: string | null;
	soniox: string | null;
}

export const resolvePaths = (env: Record<string, string | undefined> = process.env): Paths => {
	const home = env.HOME || homedir();
	const crewDir = env.CREW_CONFIG_DIR || join(home, '.crew');
	const voiceDir = join(crewDir, 'voiceos');

	return {
		home,
		crewDir,
		voiceDir,
		tokenFile: join(voiceDir, 'token'),
		sessionsFile: join(voiceDir, 'sessions.json'),
		stateFile: join(voiceDir, 'state.json'),
		logFile: join(voiceDir, 'logs', 'voiceos.log'),
		debugNotesFile: join(voiceDir, 'logs', 'debug-notes.jsonl'),
		journalDir: join(voiceDir, 'journal'),
		debugAudioDir: join(voiceDir, 'debug'),
		topicsFile: join(voiceDir, 'topics.json'),
		keysDir: env.VOICEOS_KEYS_DIR || join(home, '.config', 'crew-voiceos'),
	};
};

const readTrimmedFile = (file: string): string | null => {
	try {
		const value = readFileSync(file, 'utf8').trim();

		return value || null;
	} catch {
		// A missing or unreadable file counts as no value.
		return null;
	}
};

export const loadKeys = (
	paths: Paths,
	env: Record<string, string | undefined> = process.env,
): Keys => {
	// Keys live in files: an exported ANTHROPIC_API_KEY would switch every Claude Code session to per-token billing.
	return {
		anthropic:
			env.VOICEOS_ANTHROPIC_API_KEY ||
			readTrimmedFile(join(paths.keysDir, 'anthropic.key')) ||
			env.ANTHROPIC_API_KEY ||
			null,
		soniox: env.SONIOX_API_KEY || readTrimmedFile(join(paths.keysDir, 'soniox.key')),
	};
};

export const findMissingKeys = (keys: Keys, paths: Paths): string[] => {
	const missing: string[] = [];

	if (!keys.anthropic) {
		missing.push(join(paths.keysDir, 'anthropic.key'));
	}

	if (!keys.soniox) {
		missing.push(join(paths.keysDir, 'soniox.key'));
	}

	return missing;
};

export const ensureToken = (paths: Paths): string => {
	mkdirSync(paths.voiceDir, { recursive: true, mode: 0o700 });

	if (!existsSync(paths.tokenFile)) {
		writeFileSync(paths.tokenFile, randomBytes(32).toString('hex'), { mode: 0o600 });
	}

	// The token is the web UI's only credential: a looser mode is tightened, never trusted.
	if ((statSync(paths.tokenFile).mode & 0o077) !== 0) {
		chmodSync(paths.tokenFile, 0o600);
	}

	const token = readTrimmedFile(paths.tokenFile);

	if (!token) {
		const freshToken = randomBytes(32).toString('hex');

		writeFileSync(paths.tokenFile, freshToken, { mode: 0o600 });

		return freshToken;
	}

	return token;
};

export const shouldRecordState = (env: Record<string, string | undefined>): boolean => {
	// Only the instance crew launched records its port and pid; a manual run must not overwrite it.
	return env.VOICEOS_RECORD_STATE === '1';
};

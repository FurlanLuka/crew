// A secret one session copies to another, only after the developer allowed it: read from the
// target's folders and written to a private temp file on the asker's machine. Its bytes travel
// beside the state, never in it, so no transcript, page, log or voice line ever holds the value.
import {
	chmodSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { resolveInsideRoots, type SessionRoots } from './peer-paths.js';

export const SECRETS_KEPT_MS = 24 * 60 * 60 * 1000;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_FILES = ['.env', '.env.local'];
const MAX_SECRET_BYTES = 1024 * 1024;

export interface SecretCopy {
	id: string;
	// The asker's ref as the main knows it: where the copy goes.
	toRef: string;
	name: string;
	bytes: Buffer;
}

export type ReadSecret = { ok: true; name: string; bytes: Buffer } | { ok: false; reason: string };

const readEnvValue = (text: string, key: string): string | null => {
	for (const line of text.split('\n')) {
		const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);

		if (match?.[1] === key) {
			return match[2]?.trim() ?? '';
		}
	}

	return null;
};

// An env variable from the session's .env files, kept as one KEY=value line so it can be sourced;
// or a file in its folders, as it is.
export const readSecret = (what: string, roots: SessionRoots): ReadSecret => {
	if (ENV_NAME_PATTERN.test(what)) {
		for (const file of ENV_FILES) {
			try {
				const value = readEnvValue(readFileSync(join(roots.cwd, file), 'utf8'), what);

				if (value !== null) {
					return { ok: true, name: `${what}.env`, bytes: Buffer.from(`${what}=${value}\n`) };
				}
			} catch {
				// Not there: the next file.
			}
		}

		return { ok: false, reason: `${what} is not in the session's .env files` };
	}

	const path = resolveInsideRoots(what, roots);

	if (!path) {
		return { ok: false, reason: `${what} is outside the session's folders` };
	}

	try {
		const stats = statSync(path);

		if (!stats.isFile()) {
			return { ok: false, reason: `${what} is not a file` };
		}

		if (stats.size > MAX_SECRET_BYTES) {
			return { ok: false, reason: `${what} is over 1 MB` };
		}

		return { ok: true, name: basename(path), bytes: readFileSync(path) };
	} catch {
		return { ok: false, reason: `${what} cannot be read` };
	}
};

// A ref as a folder name: one folder per session, so its copies go when it stops.
const toFolderName = (ref: string): string => ref.replace(/[^A-Za-z0-9._-]/g, '_');

export interface WriteSecretFileParams {
	dir: string;
	ref: string;
	id: string;
	name: string;
	bytes: Buffer;
}

export const writeSecretFile = ({ dir, ref, id, name, bytes }: WriteSecretFileParams): string => {
	const folder = join(dir, toFolderName(ref), id.replace(/[^A-Za-z0-9-]/g, ''));
	const path = join(folder, basename(name).replace(/[^A-Za-z0-9._-]/g, '_') || 'secret');

	mkdirSync(folder, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	writeFileSync(path, bytes, { mode: 0o600 });

	return path;
};

export const removeSessionSecrets = (dir: string, ref: string): void => {
	rmSync(join(dir, toFolderName(ref)), { recursive: true, force: true });
};

// Copies older than a day go, whatever their session does: started on launch and hourly.
export const sweepSecrets = (dir: string, now: number, keptMs = SECRETS_KEPT_MS): number => {
	let removed = 0;

	try {
		for (const session of readdirSync(dir)) {
			for (const copy of readdirSync(join(dir, session))) {
				const path = join(dir, session, copy);

				if (now - statSync(path).mtimeMs > keptMs) {
					rmSync(path, { recursive: true, force: true });
					removed++;
				}
			}
		}
	} catch {
		// No copies yet, or one went meanwhile.
	}

	return removed;
};

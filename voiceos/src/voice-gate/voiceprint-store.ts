// The learned voice, kept across restarts: 192 numbers from the speaker model, never audio. It is
// biometric, so it stays on this machine, readable by its owner alone, and a page button forgets it.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const VERSION = 1;
// ECAPA-TDNN's embedding size.
export const VOICEPRINT_LENGTH = 192;

export interface VoiceprintRecord {
	// The models it was learned with: another model's numbers mean nothing to this one.
	packId: string;
	voiceprint: Float32Array;
	// The lock-in vector, kept for good: learning never drifts far from whoever enrolled.
	enrolled: Float32Array;
	recentScores: number[];
	turns: number;
	updatedAt: string;
}

export type ParsedVoiceprint =
	| { kind: 'found'; record: VoiceprintRecord }
	| { kind: 'ignored'; reason: string };

const toVector = (value: unknown): Float32Array | null => {
	if (
		!Array.isArray(value) ||
		value.length !== VOICEPRINT_LENGTH ||
		!value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
	) {
		return null;
	}

	const vector = Float32Array.from(value as number[]);

	return Math.hypot(...vector) === 0 ? null : vector;
};

export const parseVoiceprint = (text: string, packId: string): ParsedVoiceprint => {
	let json: Record<string, unknown>;

	try {
		json = JSON.parse(text) as Record<string, unknown>;
	} catch {
		return { kind: 'ignored', reason: 'not JSON' };
	}

	if (json?.version !== VERSION) {
		return { kind: 'ignored', reason: `version ${String(json?.version)}` };
	}

	if (json.packId !== packId) {
		return { kind: 'ignored', reason: `learned with ${String(json.packId)}` };
	}

	const voiceprint = toVector(json.voiceprint);
	const enrolled = toVector(json.enrolled);

	if (!voiceprint || !enrolled) {
		return { kind: 'ignored', reason: 'not a voiceprint' };
	}

	const { recentScores, turns, updatedAt } = json;

	if (
		!Array.isArray(recentScores) ||
		!recentScores.every((score) => typeof score === 'number' && Number.isFinite(score)) ||
		typeof turns !== 'number' ||
		!Number.isInteger(turns) ||
		turns < 0
	) {
		return { kind: 'ignored', reason: 'bad learning record' };
	}

	return {
		kind: 'found',
		record: {
			packId,
			voiceprint,
			enrolled,
			recentScores: recentScores as number[],
			turns,
			updatedAt: typeof updatedAt === 'string' ? updatedAt : '',
		},
	};
};

export type LoadedVoiceprint = ParsedVoiceprint | { kind: 'none' };

export const loadVoiceprint = (file: string, packId: string): LoadedVoiceprint => {
	let text: string;

	try {
		text = readFileSync(file, 'utf8');
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;

		// Only a missing file is no voice; one that cannot be read is said, not silently replaced.
		return code === 'ENOENT'
			? { kind: 'none' }
			: { kind: 'ignored', reason: `unreadable: ${code}` };
	}

	return parseVoiceprint(text, packId);
};

// Through a temp file beside it, renamed over: a crash mid-write leaves the old one whole.
export const saveVoiceprint = (file: string, record: VoiceprintRecord): void => {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });

	const temp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
	const json = {
		version: VERSION,
		packId: record.packId,
		voiceprint: [...record.voiceprint],
		enrolled: [...record.enrolled],
		recentScores: record.recentScores,
		turns: record.turns,
		updatedAt: record.updatedAt,
	};

	try {
		writeFileSync(temp, JSON.stringify(json), { mode: 0o600 });
		renameSync(temp, file);
	} finally {
		rmSync(temp, { force: true });
	}
};

export const deleteVoiceprint = (file: string): void => {
	rmSync(file, { force: true });
};

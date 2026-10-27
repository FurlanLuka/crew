import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createLogger } from '../log.js';
import { writeJsonAtomic } from '../memory/json-file.js';

const log = createLogger('phones');

// One write a minute per phone is enough for "last seen"; every request would rewrite the file.
export const SEEN_THROTTLE_MS = 60_000;

export interface Phone {
	id: string;
	name: string;
	keySha256: string;
	created: string;
}

export type PhoneDevice = 'iPhone' | 'Android' | 'Phone';

export interface PhoneSeen {
	seen: string;
	device: PhoneDevice;
}

export type FindPhone = (key: string) => Phone | null;
export type RecordPhoneSeen = (id: string, device: PhoneDevice) => void;

interface FileStamp {
	mtimeMs: number;
	size: number;
	ino: number;
}

interface CachedFile<T> extends FileStamp {
	value: T;
}

// Re-read only when the file changes, so a lookup per request costs one stat. A missing or broken
// file reads as `fallback` — no phones, no tailscale host.
export const createCachedJsonReader = <T>(
	file: string,
	parse: (raw: unknown) => T,
	fallback: T,
): (() => T) => {
	let cached: CachedFile<T> | null = null;

	return () => {
		let stats: FileStamp;

		try {
			stats = statSync(file);
		} catch {
			cached = null;

			return fallback;
		}

		// crew writes by rename, so a new inode catches a rewrite inside one mtime tick.
		if (
			cached &&
			cached.mtimeMs === stats.mtimeMs &&
			cached.size === stats.size &&
			cached.ino === stats.ino
		) {
			return cached.value;
		}

		try {
			const value = parse(JSON.parse(readFileSync(file, 'utf8')));

			cached = { mtimeMs: stats.mtimeMs, size: stats.size, ino: stats.ino, value };
			log.debug('file read', { file });

			return value;
		} catch (error) {
			log.warn('file unreadable', { file, error: String(error) });
			cached = null;

			return fallback;
		}
	};
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

export const parsePhones = (raw: unknown): Phone[] => {
	if (!isRecord(raw) || !Array.isArray(raw.phones)) {
		return [];
	}

	return raw.phones.flatMap((entry: unknown) => {
		if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.key_sha256 !== 'string') {
			return [];
		}

		return [
			{
				id: entry.id,
				name: typeof entry.name === 'string' ? entry.name : 'Phone',
				keySha256: entry.key_sha256.toLowerCase(),
				created: typeof entry.created === 'string' ? entry.created : '',
			},
		];
	});
};

export const hashKey = (key: string): Buffer => createHash('sha256').update(key).digest();

// Every phone is compared, matched or not, so the time taken says nothing about which hash was close.
export const matchPhone = (phones: Phone[], key: string): Phone | null => {
	if (!key) {
		return null;
	}

	const digest = hashKey(key);
	let found: Phone | null = null;

	for (const phone of phones) {
		const stored = Buffer.from(phone.keySha256, 'hex');

		if (stored.length === digest.length && timingSafeEqual(stored, digest) && !found) {
			found = phone;
		}
	}

	return found;
};

export const deviceFromUserAgent = (userAgent: string | null | undefined): PhoneDevice => {
	const agent = userAgent ?? '';

	if (/iPhone|iPad|iPod/i.test(agent)) {
		return 'iPhone';
	}

	if (/Android/i.test(agent)) {
		return 'Android';
	}

	return 'Phone';
};

const BROWSERS: Array<[RegExp, string]> = [
	[/Edg\//, 'Edge'],
	[/Firefox\/|FxiOS/, 'Firefox'],
	[/Chrome\/|CriOS/, 'Chrome'],
	[/Safari\//, 'Safari'],
];

const SYSTEMS: Array<[RegExp, string]> = [
	[/Macintosh|Mac OS X/, 'Mac'],
	[/Windows/, 'Windows'],
	[/CrOS/, 'ChromeOS'],
	[/Linux/, 'Linux'],
];

// What the "open on <device>" overlay names: the phone kind, or system and browser on a computer.
export const describeDevice = (userAgent: string | null | undefined): string => {
	const phone = deviceFromUserAgent(userAgent);

	if (phone !== 'Phone') {
		return phone;
	}

	const agent = userAgent ?? '';
	const system = SYSTEMS.find(([pattern]) => pattern.test(agent))?.[1];
	const browser = BROWSERS.find(([pattern]) => pattern.test(agent))?.[1];

	if (system && browser) {
		return `${system} · ${browser}`;
	}

	return system ?? browser ?? 'Browser';
};

export const shouldRecordSeen = (lastMs: number | undefined, nowMs: number): boolean =>
	lastMs === undefined || nowMs - lastMs >= SEEN_THROTTLE_MS;

const parseSeen = (raw: unknown): Record<string, PhoneSeen> => {
	if (!isRecord(raw)) {
		return {};
	}

	const seen: Record<string, PhoneSeen> = {};

	for (const [id, entry] of Object.entries(raw)) {
		if (isRecord(entry) && typeof entry.seen === 'string' && typeof entry.device === 'string') {
			seen[id] = { seen: entry.seen, device: entry.device as PhoneDevice };
		}
	}

	return seen;
};

const readSeenFile = (file: string): Record<string, PhoneSeen> => {
	try {
		return parseSeen(JSON.parse(readFileSync(file, 'utf8')));
	} catch {
		// Missing on the first visit; a broken file is rewritten whole by the next record.
		return {};
	}
};

export interface CreatePhonesParams {
	phonesFile: string;
	seenFile: string;
	now?: () => number;
}

export interface Phones {
	findPhone: FindPhone;
	hasPhone: (id: string) => boolean;
	recordSeen: RecordPhoneSeen;
}

export const createPhones = ({
	phonesFile,
	seenFile,
	now = Date.now,
}: CreatePhonesParams): Phones => {
	const readPhones = createCachedJsonReader(phonesFile, parsePhones, []);
	const lastRecorded = new Map<string, number>();

	return {
		findPhone: (key) => matchPhone(readPhones(), key),
		hasPhone: (id) => readPhones().some((phone) => phone.id === id),
		recordSeen: (id, device) => {
			const nowMs = now();

			if (!shouldRecordSeen(lastRecorded.get(id), nowMs)) {
				return;
			}

			lastRecorded.set(id, nowMs);

			try {
				const seen = readSeenFile(seenFile);

				seen[id] = { seen: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z'), device };
				writeJsonAtomic(seenFile, seen);
				log.info('phone seen', { id, device });
			} catch (error) {
				log.warn('phone seen not recorded', { id, error: String(error) });
			}
		},
	};
};

const parseTailscale = (raw: unknown): string | null =>
	isRecord(raw) && typeof raw.host === 'string' && raw.host ? raw.host : null;

// Written by crew when the machine is served over Tailscale; the page then loads from its https host.
export const createTailscaleHostReader = (file: string): (() => string | null) =>
	createCachedJsonReader(file, parseTailscale, null);

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureLog } from '../log.js';
import {
	createPhones,
	createTailscaleHostReader,
	deviceFromUserAgent,
	hashKey,
	matchPhone,
	parsePhones,
	SEEN_THROTTLE_MS,
	shouldRecordSeen,
} from './phones.js';

configureLog({ quiet: true });

const phonesJson = (entries: Array<{ id: string; key: string }>) =>
	JSON.stringify({
		phones: entries.map(({ id, key }) => ({
			id,
			name: 'Phone',
			key_sha256: hashKey(key).toString('hex'),
			created: '2026-10-26T10:00:00Z',
		})),
	});

describe('deviceFromUserAgent', () => {
	it.each([
		[
			'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
			'iPhone',
		],
		['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 'iPhone'],
		['Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/130.0 Mobile Safari/537.36', 'Android'],
		['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', 'Phone'],
		[null, 'Phone'],
	])('%s → %s', (agent, device) => expect(deviceFromUserAgent(agent)).toBe(device as never));
});

describe('matchPhone', () => {
	const phones = parsePhones(
		JSON.parse(
			phonesJson([
				{ id: 'p1', key: 'k-one' },
				{ id: 'p2', key: 'k-two' },
			]),
		),
	);

	it('finds the phone whose hash matches the key', () =>
		expect(matchPhone(phones, 'k-two')?.id).toBe('p2'));
	it('an unknown or empty key matches nothing', () => {
		expect(matchPhone(phones, 'nope')).toBeNull();
		expect(matchPhone(phones, '')).toBeNull();
	});
	it('a malformed file reads as no phones', () => {
		expect(parsePhones({ phones: 'x' })).toEqual([]);
		expect(parsePhones({ phones: [{ id: 'p1' }] })).toEqual([]);
	});
});

describe('shouldRecordSeen', () => {
	it('first time, then once a minute', () => {
		expect(shouldRecordSeen(undefined, 0)).toBe(true);
		expect(shouldRecordSeen(1000, 1000 + SEEN_THROTTLE_MS - 1)).toBe(false);
		expect(shouldRecordSeen(1000, 1000 + SEEN_THROTTLE_MS)).toBe(true);
	});
});

describe('createPhones', () => {
	it('a phone removed from phones.json is not found on the next lookup', () => {
		const dir = mkdtempSync(join(tmpdir(), 'voiceos-phones-'));
		const phonesFile = join(dir, 'phones.json');
		const phones = createPhones({ phonesFile, seenFile: join(dir, 'seen.json') });

		expect(phones.findPhone('k-one')).toBeNull();
		writeFileSync(phonesFile, phonesJson([{ id: 'p1', key: 'k-one' }]));
		expect(phones.findPhone('k-one')?.id).toBe('p1');
		writeFileSync(phonesFile, JSON.stringify({ phones: [] }));
		expect(phones.findPhone('k-one')).toBeNull();
	});

	it('seen is recorded with the device, and throttled per phone', () => {
		const dir = mkdtempSync(join(tmpdir(), 'voiceos-phones-'));
		const seenFile = join(dir, 'seen.json');
		let nowMs = Date.parse('2026-10-26T10:00:00Z');
		const phones = createPhones({
			phonesFile: join(dir, 'phones.json'),
			seenFile,
			now: () => nowMs,
		});
		const read = () => JSON.parse(readFileSync(seenFile, 'utf8'));

		phones.recordSeen('p1', 'iPhone');
		expect(read()).toEqual({ p1: { seen: '2026-10-26T10:00:00Z', device: 'iPhone' } });

		nowMs += 30_000;
		phones.recordSeen('p1', 'Android');
		phones.recordSeen('p2', 'Android');
		expect(read().p1.device).toBe('iPhone');
		expect(read().p2).toEqual({ seen: '2026-10-26T10:00:30Z', device: 'Android' });

		nowMs += SEEN_THROTTLE_MS;
		phones.recordSeen('p1', 'Android');
		expect(read().p1).toEqual({ seen: '2026-10-26T10:01:30Z', device: 'Android' });
	});
});

describe('createTailscaleHostReader', () => {
	it('reads the host, and none when the file is missing', () => {
		const dir = mkdtempSync(join(tmpdir(), 'voiceos-ts-'));
		const file = join(dir, 'tailscale.json');
		const read = createTailscaleHostReader(file);

		expect(read()).toBeNull();
		writeFileSync(
			file,
			JSON.stringify({ host: 'mac.tail1.ts.net', url: 'https://mac.tail1.ts.net' }),
		);
		expect(read()).toBe('mac.tail1.ts.net');
	});
});

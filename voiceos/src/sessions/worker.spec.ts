import { describe, expect, it } from 'bun:test';
import { buildWorkerEnv } from './worker.js';

const base = {
	PATH: '/usr/bin',
	ANTHROPIC_API_KEY: 'k',
	ANTHROPIC_AUTH_TOKEN: 't',
	SONIOX_API_KEY: 's',
	VOICEOS_ANTHROPIC_API_KEY: 'v',
	HOME: '/wrong',
};

describe('buildWorkerEnv', () => {
	it('strips every key that would change billing or leak speech credentials', () => {
		const env = buildWorkerEnv({
			base,
			ref: 'store/main',
			home: '/Users/me',
			shouldKeepApiKey: false,
		});

		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
		expect(env.SONIOX_API_KEY).toBeUndefined();
		expect(env.VOICEOS_ANTHROPIC_API_KEY).toBeUndefined();

		// Removed, not set to undefined: a child process given the key at all could pick it up.
		for (const key of [
			'ANTHROPIC_API_KEY',
			'ANTHROPIC_AUTH_TOKEN',
			'SONIOX_API_KEY',
			'VOICEOS_ANTHROPIC_API_KEY',
		]) {
			expect(key in env).toBe(false);
		}
	});

	it('sets HOME explicitly and CREW_REF like crew claude does', () => {
		expect(
			buildWorkerEnv({ base, ref: 'store/main', home: '/Users/me', shouldKeepApiKey: false }),
		).toMatchObject({ HOME: '/Users/me', CREW_REF: 'store/main', PATH: '/usr/bin' });
	});

	it('keepApiKey (tests only) → keeps ANTHROPIC_API_KEY, still strips the rest', () => {
		const env = buildWorkerEnv({ base, ref: 'r', home: '/h', shouldKeepApiKey: true });

		expect(env.ANTHROPIC_API_KEY).toBe('k');
		expect(env.SONIOX_API_KEY).toBeUndefined();
	});

	it('does not mutate the base env', () => {
		buildWorkerEnv({ base, ref: 'r', home: '/h', shouldKeepApiKey: false });
		expect(base.ANTHROPIC_API_KEY).toBe('k');
	});
});

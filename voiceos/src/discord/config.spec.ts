import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDiscordMode, readDiscordSetup, writeDiscordStatus } from './config.js';

// The files crew writes and reads, shared with its Go tests.
const SHARED = JSON.parse(
	readFileSync(join(import.meta.dir, '../../test/fixtures/shared/discord-files.json'), 'utf8'),
);

let dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs) {
		rmSync(dir, { recursive: true, force: true });
	}

	dirs = [];
});

const makeDirs = ({ config, key }: { config?: string; key?: string }) => {
	const voiceDir = mkdtempSync(join(tmpdir(), 'voiceos-discord-config-'));
	const keysDir = mkdtempSync(join(tmpdir(), 'voiceos-discord-keys-'));
	dirs.push(voiceDir, keysDir);

	if (config !== undefined) {
		writeFileSync(join(voiceDir, 'discord.json'), config);
	}

	if (key !== undefined) {
		writeFileSync(join(keysDir, 'discord.key'), key);
	}

	return { voiceDir, keysDir };
};

describe('readDiscordSetup', () => {
	it("crew's discord.json and the key → where to join and whom to hear", () =>
		expect(
			readDiscordSetup(makeDirs({ config: JSON.stringify(SHARED.config), key: 'bot-token\n' })),
		).toEqual({
			token: 'bot-token',
			guild: '1001',
			channel: '2002',
			owner: '3003',
			channelName: 'Voice OS',
		}));

	it('no channel name → a generic one', () => {
		const { channel_name: _, ...config } = SHARED.config;

		expect(
			readDiscordSetup(makeDirs({ config: JSON.stringify(config), key: 't' }))?.channelName,
		).toBe('voice channel');
	});

	it('broken JSON, a missing owner, or a blank key → not set up', () => {
		const { owner: _, ...noOwner } = SHARED.config;

		expect(readDiscordSetup(makeDirs({ config: '{', key: 't' }))).toBeNull();
		expect(readDiscordSetup(makeDirs({ config: JSON.stringify(noOwner), key: 't' }))).toBeNull();
		expect(
			readDiscordSetup(makeDirs({ config: JSON.stringify(SHARED.config), key: '  \n' })),
		).toBeNull();
	});
});

describe('loadDiscordMode', () => {
	it('no file, a corrupt one, or push to talk (meaningless in a channel) → hands-free', () => {
		const { voiceDir } = makeDirs({});

		expect(loadDiscordMode(voiceDir)).toBe('hands-free');
		writeFileSync(join(voiceDir, 'discord-mode.json'), '{');
		expect(loadDiscordMode(voiceDir)).toBe('hands-free');
		writeFileSync(join(voiceDir, 'discord-mode.json'), '{"mode":"push"}');
		expect(loadDiscordMode(voiceDir)).toBe('hands-free');
	});
});

describe('writeDiscordStatus', () => {
	it('the shape crew reads', () => {
		const { voiceDir } = makeDirs({});

		writeDiscordStatus(voiceDir, SHARED.status);

		expect(JSON.parse(readFileSync(join(voiceDir, 'discord-status.json'), 'utf8'))).toEqual(
			SHARED.status,
		);
	});
});

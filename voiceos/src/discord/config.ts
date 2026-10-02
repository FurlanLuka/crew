// What `crew server discord setup` leaves behind (discord.json and the bot token), the listening mode the
// developer chose for Discord, and the status file `crew server discord status` reads.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { writeJsonAtomic } from '../memory/json-file.js';
import type { ListeningMode } from '../shared/protocol.js';
import type { DiscordTarget } from './link.js';

export const DISCORD_FILE = 'discord.json';
const STATUS_FILE = 'discord-status.json';
const MODE_FILE = 'discord-mode.json';
const KEY_FILE = 'discord.key';

export interface DiscordSetup extends DiscordTarget {
	channelName: string;
}

const setupSchema = z.object({
	guild: z.string().min(1),
	channel: z.string().min(1),
	owner: z.string().min(1),
	channel_name: z.string().optional(),
});

const modeSchema = z.object({ mode: z.enum(['on-demand', 'hands-free']) });

interface DirsParams {
	voiceDir: string;
	keysDir: string;
}

const readText = (file: string): string | null => {
	try {
		return readFileSync(file, 'utf8').trim() || null;
	} catch {
		// Missing: Discord is not set up.
		return null;
	}
};

// Null unless both halves are there: a config without its token, or the reverse, connects nowhere.
export const readDiscordSetup = ({ voiceDir, keysDir }: DirsParams): DiscordSetup | null => {
	const token = readText(join(keysDir, KEY_FILE));
	const text = readText(join(voiceDir, DISCORD_FILE));

	if (!token || !text) {
		return null;
	}

	try {
		const parsed = setupSchema.parse(JSON.parse(text));

		return {
			token,
			guild: parsed.guild,
			channel: parsed.channel,
			owner: parsed.owner,
			channelName: parsed.channel_name || 'voice channel',
		};
	} catch {
		return null;
	}
};

export const isSameSetup = (a: DiscordSetup | null, b: DiscordSetup | null): boolean =>
	JSON.stringify(a) === JSON.stringify(b);

// Hands-free until the developer picks: in a voice channel there is no button to press.
export const loadDiscordMode = (voiceDir: string): ListeningMode => {
	try {
		return modeSchema.parse(JSON.parse(readFileSync(join(voiceDir, MODE_FILE), 'utf8'))).mode;
	} catch {
		return 'hands-free';
	}
};

export const saveDiscordMode = (voiceDir: string, mode: ListeningMode): void =>
	writeJsonAtomic(join(voiceDir, MODE_FILE), { mode });

interface DiscordStatus {
	connected: boolean;
	owner_in_channel: boolean;
	error: string;
	at: string;
}

export const writeDiscordStatus = (voiceDir: string, status: DiscordStatus): void =>
	writeJsonAtomic(join(voiceDir, STATUS_FILE), status);

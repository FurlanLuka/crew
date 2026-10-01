// The Discord side: a bot that sits in one voice channel, hears only the owner and plays clips. Everything
// past this file is plain PCM and events (bridge.ts).
import { PassThrough } from 'node:stream';
import {
	AudioPlayerStatus,
	EndBehaviorType,
	VoiceConnectionStatus,
	createAudioPlayer,
	createAudioResource,
	entersState,
	joinVoiceChannel,
	StreamType,
	type AudioPlayer,
	type VoiceConnection,
} from '@discordjs/voice';
import { Client, GatewayIntentBits } from 'discord.js';
import { createLogger } from '../log.js';
import type { ClipSink, VoiceLink, VoiceLinkEvents } from './bridge.js';

const log = createLogger('discord');

const READY_TIMEOUT_MS = 20_000;
const RETRY_FIRST_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
// Speech streams in faster than it plays but not evenly; the player's default (5 frames, 100 ms of no
// data) would end a clip between two chunks. VoiceOut's own timer catches a clip that is really stuck.
const MAX_MISSED_FRAMES = 500;

export interface DiscordTarget {
	token: string;
	guild: string;
	channel: string;
	owner: string;
}

// What the link needs from discord.js, so its reconnecting can be tested without Discord.
export interface DiscordGateway {
	// Resolves once the bot is logged in and its servers are known.
	login: () => Promise<void>;
	hasGuild: () => boolean;
	isOwnerIn: () => boolean;
	onOwnerMoved: (listener: (isIn: boolean) => void) => void;
	joinChannel: () => VoiceConnection;
	destroy: () => void;
}

export interface LinkDeps {
	gateway: DiscordGateway;
	waitReady: (connection: VoiceConnection) => Promise<unknown>;
	player?: AudioPlayer;
	setTimer?: (run: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
}

const createGateway = (target: DiscordTarget): DiscordGateway => {
	const client = new Client({
		intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
	});
	const guild = () => client.guilds.cache.get(target.guild);

	client.on('error', (error) => log.warn('discord client error', { error: String(error) }));

	return {
		login: async () => {
			const ready = new Promise<void>((resolve) => client.once('ready', () => resolve()));

			await client.login(target.token);
			await ready;
		},
		hasGuild: () => guild() !== undefined,
		isOwnerIn: () => guild()?.voiceStates.cache.get(target.owner)?.channelId === target.channel,
		onOwnerMoved: (listener) =>
			client.on('voiceStateUpdate', (before, after) => {
				const wasIn = before.channelId === target.channel;
				const isIn = after.channelId === target.channel;

				if (after.id === target.owner && after.guild.id === target.guild && wasIn !== isIn) {
					listener(isIn);
				}
			}),
		joinChannel: () =>
			joinVoiceChannel({
				guildId: target.guild,
				channelId: target.channel,
				adapterCreator: guild()!.voiceAdapterCreator,
				selfDeaf: false,
				daveEncryption: true,
			}),
		destroy: () => void client.destroy(),
	};
};

// discord.js tags a token Discord refused; anything else (no network, DNS, an outage) passes.
const isTokenRejected = (error: unknown): boolean =>
	typeof error === 'object' &&
	error !== null &&
	(error as { code?: unknown }).code === 'TokenInvalid';

const destroyQuietly = (connection: VoiceConnection | null): void => {
	// destroy() throws on a connection already destroyed (Discord can do it first).
	if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
		connection.destroy();
	}
};

export const connectDiscord = (
	target: DiscordTarget,
	events: VoiceLinkEvents,
	deps: LinkDeps = {
		gateway: createGateway(target),
		waitReady: (connection) =>
			entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS),
	},
): VoiceLink => {
	const { gateway, waitReady } = deps;
	const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
	const clearTimer =
		deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
	const player =
		deps.player ?? createAudioPlayer({ behaviors: { maxMissedFrames: MAX_MISSED_FRAMES } });
	let connection: VoiceConnection | null = null;
	let ownerStream: { destroy: () => void } | null = null;
	let isLoggedIn = false;
	let retryMs = RETRY_FIRST_MS;
	let retryTimer: unknown = null;
	let isClosed = false;

	player.on(AudioPlayerStatus.Idle, () => events.onPlaybackIdle());
	player.on('error', (error) => log.warn('player error', { error: String(error) }));

	const hearOwner = (): void => {
		if (!connection || ownerStream) {
			return;
		}

		// Subscribed by the owner's id alone: no one else's audio is ever received or decoded.
		const stream = connection.receiver.subscribe(target.owner, {
			end: { behavior: EndBehaviorType.Manual },
		});
		stream.on('data', (packet: Buffer) => events.onOwnerPacket(new Uint8Array(packet)));
		stream.on('error', (error) => log.warn('owner stream error', { error: String(error) }));
		ownerStream = stream;
	};

	const stopHearing = (): void => {
		ownerStream?.destroy();
		ownerStream = null;
	};

	const setOwner = (isIn: boolean): void => {
		if (isIn) {
			hearOwner();
		} else {
			stopHearing();
		}

		events.onOwner(isIn);
	};

	// Takes the connection out before destroying it: its own Destroyed event must not read as a drop.
	const dropConnection = (): void => {
		const previous = connection;

		connection = null;
		stopHearing();
		destroyQuietly(previous);
	};

	const retry = (reason: string): void => {
		if (isClosed || retryTimer) {
			return;
		}

		log.warn('discord retry', { reason, inMs: retryMs });
		events.onConnected(false, reason);
		retryTimer = setTimer(() => {
			retryTimer = null;
			void start();
		}, retryMs);
		retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
	};

	const join = async (): Promise<void> => {
		if (!gateway.hasGuild()) {
			retry('the bot is not in the server');

			return;
		}

		dropConnection();
		log.info('joining voice channel', { guild: target.guild, channel: target.channel });
		const joined = gateway.joinChannel();
		connection = joined;
		joined.on('error', (error) => log.warn('voice error', { error: String(error) }));
		joined.on('stateChange', (_, next) => {
			const isDropped =
				next.status === VoiceConnectionStatus.Disconnected ||
				next.status === VoiceConnectionStatus.Destroyed;

			if (isDropped && connection === joined && !isClosed) {
				dropConnection();
				retry(`voice ${next.status}`);
			}
		});

		try {
			await waitReady(joined);
		} catch (error) {
			if (connection === joined) {
				dropConnection();
				retry(`voice not ready: ${String(error)}`);
			}

			return;
		}

		if (connection !== joined || isClosed) {
			return;
		}

		retryMs = RETRY_FIRST_MS;
		joined.subscribe(player);
		events.onConnected(true);
		setOwner(gateway.isOwnerIn());
	};

	const start = async (): Promise<void> => {
		if (isLoggedIn) {
			return join();
		}

		try {
			await gateway.login();
		} catch (error) {
			if (isClosed) {
				return;
			}

			// A refused token stays refused: no retry until the setup changes.
			if (isTokenRejected(error)) {
				log.error('discord login refused', { error: String(error) });
				events.onConnected(false, `login failed: ${String(error)}`);

				return;
			}

			retry(`login failed: ${String(error)}`);

			return;
		}

		isLoggedIn = true;

		if (!isClosed) {
			await join();
		}
	};

	gateway.onOwnerMoved((isIn) => {
		if (connection?.state.status === VoiceConnectionStatus.Ready) {
			setOwner(isIn);
		}
	});
	void start();

	return {
		startClip: (): ClipSink => {
			// One Opus packet per read: the player takes a frame each 20 ms.
			const stream = new PassThrough({ objectMode: true });
			player.play(createAudioResource(stream, { inputType: StreamType.Opus }));

			return {
				push: (packet) => stream.write(Buffer.from(packet)),
				end: () => stream.end(),
			};
		},
		stopPlayback: () => player.stop(true),
		close: () => {
			isClosed = true;

			if (retryTimer) {
				clearTimer(retryTimer);
			}

			player.stop(true);
			dropConnection();
			gateway.destroy();
		},
	};
};

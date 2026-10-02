// Discord wired into Voice OS: follows the setup crew writes, keeps one bridge connected, and tells the
// state (and `crew server discord status`) where it stands.
import { watch } from 'node:fs';
import { createLogger } from '../log.js';
import type { DiscordPresence, ListeningMode, ServerMessage } from '../shared/protocol.js';
import type { Store } from '../state/store.js';
import { DiscordBridge, type VoiceLink, type VoiceLinkEvents } from './bridge.js';
import { createOpusCodec, type OpusCodec } from './codec.js';
import {
	DISCORD_FILE,
	isSameSetup,
	loadDiscordMode,
	readDiscordSetup,
	saveDiscordMode,
	writeDiscordStatus,
	type DiscordSetup,
} from './config.js';
import { connectDiscord, type DiscordTarget } from './link.js';

const log = createLogger('discord');

export interface DiscordVoiceOptions {
	store: Store;
	voiceDir: string;
	keysDir: string;
	// The owner is in the channel and Voice OS hears them in this mode; also called again on a mode change.
	onOwnerIn: (mode: ListeningMode) => void;
	onOwnerOut: () => void;
	onAudio: (mono: Uint8Array) => void;
	onClipDone: (id: string) => void;
	openLink?: (target: DiscordTarget, events: VoiceLinkEvents) => VoiceLink;
	createCodec?: () => OpusCodec;
	now?: () => number;
}

export interface DiscordVoice {
	// What Voice OS sends the `discord` client; false when Discord cannot take it.
	send: (message: ServerMessage) => boolean;
	isOwnerIn: () => boolean;
	setMode: (mode: ListeningMode) => void;
	reload: () => void;
	stop: () => void;
}

export const startDiscordVoice = (options: DiscordVoiceOptions): DiscordVoice => {
	const openLink = options.openLink ?? connectDiscord;
	const now = options.now ?? Date.now;
	let setup: DiscordSetup | null = null;
	let bridge: DiscordBridge | null = null;
	let presence: DiscordPresence | null = null;
	let error = '';
	let mode = loadDiscordMode(options.voiceDir);

	const publish = (next: DiscordPresence | null): void => {
		presence = next;
		options.store.dispatch({ type: 'discord_presence', presence: next });

		try {
			writeDiscordStatus(options.voiceDir, {
				connected: next?.isConnected ?? false,
				owner_in_channel: next?.isOwnerIn ?? false,
				error,
				at: new Date(now()).toISOString(),
			});
		} catch (writeError) {
			log.warn('discord status not written', { error: String(writeError) });
		}
	};

	const update = (change: Partial<DiscordPresence>): void => {
		if (presence) {
			publish({ ...presence, ...change });
		}
	};

	const setMode = (next: ListeningMode): void => {
		mode = next;
		log.info('discord listening mode', { mode });

		try {
			saveDiscordMode(options.voiceDir, mode);
		} catch (saveError) {
			log.warn('discord mode not saved', { error: String(saveError) });
		}

		update({ mode, isHearing: bridge?.ownerIsIn ?? false });

		if (bridge?.ownerIsIn) {
			options.onOwnerIn(mode);
		}
	};

	const disconnect = (): void => {
		bridge?.detach();
		bridge = null;
	};

	const connect = (next: DiscordSetup): void => {
		// A link replaced by a new setup can still report on its way out; only the current one counts.
		const isCurrent = (): boolean => bridge === current;
		const current: DiscordBridge = new DiscordBridge({
			codec: (options.createCodec ?? createOpusCodec)(),
			onAudio: options.onAudio,
			onClipDone: options.onClipDone,
			onMode: setMode,
			onListenOff: (reason) => {
				log.warn('not hearing the voice channel', { reason });
				update({ isHearing: false });
			},
			onConnected: (isConnected, reason) => {
				if (!isCurrent()) {
					return;
				}

				error = reason ?? '';
				update({ isConnected });
			},
			onOwner: (isIn) => {
				// Detaching tells the app the owner is out even for the old bridge (its listener must go);
				// an old bridge never brings them in.
				if (!isCurrent() && isIn) {
					return;
				}

				if (isCurrent()) {
					update({ isOwnerIn: isIn, isHearing: isIn });
				}

				if (isIn) {
					options.onOwnerIn(mode);
				} else {
					options.onOwnerOut();
				}
			},
			...(options.now ? { now: options.now } : {}),
		});

		bridge = current;
		publish({
			isConnected: false,
			isOwnerIn: false,
			isHearing: false,
			channelName: next.channelName,
			mode,
		});
		log.info('discord set up', { guild: next.guild, channel: next.channel });
		current.attach(openLink(next, current.events));
	};

	// Setup and off apply without a restart: the file is read again whenever it changes.
	const reload = (): void => {
		const next = readDiscordSetup(options);

		if (isSameSetup(next, setup)) {
			return;
		}

		disconnect();
		setup = next;
		error = '';

		if (next) {
			connect(next);
		} else {
			log.info('discord not set up');
			publish(null);
		}
	};

	reload();

	let watcher: ReturnType<typeof watch> | null = null;

	try {
		watcher = watch(options.voiceDir, (_event, file) => {
			if (file === DISCORD_FILE) {
				reload();
			}
		});
	} catch (watchError) {
		log.warn('discord setup not watched; read at start only', { error: String(watchError) });
	}

	return {
		send: (message) => bridge?.send(message) ?? false,
		isOwnerIn: () => bridge?.ownerIsIn ?? false,
		setMode,
		reload,
		stop: () => {
			watcher?.close();
			disconnect();
			// Closing reports nothing, and crew must not read "connected" from a stopped Voice OS.
			update({ isConnected: false, isOwnerIn: false, isHearing: false });
		},
	};
};

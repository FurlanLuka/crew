import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { VoiceConnectionStatus, type VoiceConnection } from '@discordjs/voice';
import type { VoiceLinkEvents } from './bridge.js';
import { connectDiscord, type DiscordGateway } from './link.js';

const TARGET = { token: 't', guild: 'g1', channel: 'c1', owner: 'u1' };

// A voice connection as @discordjs/voice behaves: a state change is emitted synchronously, destroying
// twice throws.
class FakeConnection extends EventEmitter {
	state: { status: VoiceConnectionStatus } = { status: VoiceConnectionStatus.Signalling };
	receiver = { subscribe: () => Object.assign(new EventEmitter(), { destroy: () => {} }) };

	setStatus(status: VoiceConnectionStatus): void {
		const previous = this.state;
		this.state = { status };
		this.emit('stateChange', previous, this.state);
	}

	destroy(): void {
		if (this.state.status === VoiceConnectionStatus.Destroyed) {
			throw new Error('Cannot destroy VoiceConnection - it has already been destroyed');
		}

		this.setStatus(VoiceConnectionStatus.Destroyed);
	}

	subscribe(): void {}
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const setup = ({ login = async () => {} }: { login?: () => Promise<void> } = {}) => {
	const connections: FakeConnection[] = [];
	const timers: (() => void)[] = [];
	const connected: (string | true)[] = [];
	const owner: boolean[] = [];
	let logins = 0;
	let isOwnerIn = true;
	const gateway: DiscordGateway = {
		login: () => {
			logins++;

			return login();
		},
		hasGuild: () => true,
		isOwnerIn: () => isOwnerIn,
		onOwnerMoved: () => {},
		joinChannel: () => {
			const connection = new FakeConnection();
			connections.push(connection);

			return connection as unknown as VoiceConnection;
		},
		destroy: () => {},
	};
	const events: VoiceLinkEvents = {
		onConnected: (isConnected, error) => connected.push(isConnected || (error ?? '')),
		onOwner: (isIn) => owner.push(isIn),
		onOwnerPacket: () => {},
		onPlaybackIdle: () => {},
	};

	// Ready as soon as asked, unless the connection already dropped.
	const waitReady = async (connection: VoiceConnection) => {
		const fake = connection as unknown as FakeConnection;

		if (fake.state.status !== VoiceConnectionStatus.Destroyed) {
			fake.setStatus(VoiceConnectionStatus.Ready);
		}
	};

	const link = connectDiscord(TARGET, events, {
		gateway,
		waitReady,
		setTimer: (run) => timers.push(run),
		clearTimer: () => {},
	});

	return {
		link,
		connections,
		timers,
		connected,
		owner,
		logins: () => logins,
		setOwnerIn: (isIn: boolean) => {
			isOwnerIn = isIn;
		},
		runTimers: async () => {
			const due = timers.splice(0);

			for (const run of due) {
				run();
			}

			await flush();
		},
	};
};

describe('connectDiscord', () => {
	it('logged in → joins, reports connected and whether the owner is in', async () => {
		const t = setup();
		await flush();

		expect(t.connections).toHaveLength(1);
		expect(t.connected).toEqual([true]);
		expect(t.owner).toEqual([true]);
	});

	it('one drop → exactly one rejoin, and it holds', async () => {
		const t = setup();
		await flush();

		t.connections[0]?.setStatus(VoiceConnectionStatus.Disconnected);
		expect(t.timers).toHaveLength(1);

		await t.runTimers();

		expect(t.connections).toHaveLength(2);
		expect(t.connections[1]?.state.status).toBe(VoiceConnectionStatus.Ready);
		expect(t.timers).toEqual([]);
		expect(t.connected).toEqual([true, 'voice disconnected', true]);
		// Logged in once: a voice drop never logs in again.
		expect(t.logins()).toBe(1);
	});

	it('Discord destroys the connection itself → closing later does not throw', async () => {
		const t = setup();
		await flush();

		t.connections[0]?.destroy();

		expect(() => t.link.close()).not.toThrow();
	});

	it('closed → a pending retry never rejoins', async () => {
		const t = setup();
		await flush();

		t.connections[0]?.setStatus(VoiceConnectionStatus.Disconnected);
		t.link.close();
		await flush();

		expect(t.connections).toHaveLength(1);
	});

	it('no network at login → tried again later', async () => {
		let attempts = 0;
		const t = setup({
			login: async () => {
				attempts++;

				if (attempts === 1) {
					throw new Error('getaddrinfo ENOTFOUND discord.com');
				}
			},
		});
		await flush();

		expect(t.connections).toEqual([]);
		expect(t.timers).toHaveLength(1);

		await t.runTimers();

		expect(t.logins()).toBe(2);
		expect(t.connections).toHaveLength(1);
	});

	it('the token refused → reported, never retried', async () => {
		const t = setup({
			login: async () => {
				throw Object.assign(new Error('An invalid token was provided.'), { code: 'TokenInvalid' });
			},
		});
		await flush();

		expect(t.timers).toEqual([]);
		expect(t.connected).toEqual(['login failed: Error: An invalid token was provided.']);
	});
});

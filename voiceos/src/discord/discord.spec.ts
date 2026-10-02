import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ListeningMode } from '../shared/protocol.js';
import { Store } from '../state/store.js';
import type { VoiceLinkEvents } from './bridge.js';
import { type DiscordVoice, startDiscordVoice } from './discord.js';
import type { DiscordTarget } from './link.js';

const SETUP = {
	guild: 'g1',
	channel: 'c1',
	channel_name: 'Voice OS',
	guild_name: 'Home',
	owner: 'u1',
};

let dirs: string[] = [];
let voices: DiscordVoice[] = [];

afterEach(() => {
	for (const voice of voices) {
		voice.stop();
	}

	for (const dir of dirs) {
		rmSync(dir, { recursive: true, force: true });
	}

	dirs = [];
	voices = [];
});

const start = ({ isSetUp = true, hasToken = true, savedMode = '', startPaused = false } = {}) => {
	const voiceDir = mkdtempSync(join(tmpdir(), 'voiceos-discord-'));
	const keysDir = mkdtempSync(join(tmpdir(), 'voiceos-keys-'));
	dirs.push(voiceDir, keysDir);

	if (isSetUp) {
		writeFileSync(join(voiceDir, 'discord.json'), JSON.stringify(SETUP));
	}

	if (savedMode) {
		writeFileSync(join(voiceDir, 'discord-mode.json'), JSON.stringify({ mode: savedMode }));
	}

	if (hasToken) {
		writeFileSync(join(keysDir, 'discord.key'), 'bot-token\n');
	}

	const store = new Store();
	const targets: DiscordTarget[] = [];
	const ownerIn: ListeningMode[] = [];
	let ownerOut = 0;
	let closed = 0;
	const linkEvents: VoiceLinkEvents[] = [];

	const voice = startDiscordVoice({
		store,
		voiceDir,
		keysDir,
		onOwnerIn: (mode) => ownerIn.push(mode),
		onOwnerOut: () => {
			ownerOut++;
		},
		onAudio: () => {},
		onClipDone: () => {},
		openLink: (target, events) => {
			targets.push(target);
			linkEvents.push(events);

			return {
				startClip: () => ({ push: () => {}, end: () => {} }),
				stopPlayback: () => {},
				close: () => closed++,
			};
		},
		createCodec: () => ({ encode: (frame) => frame, decode: (packet) => packet }),
		now: () => Date.parse('2026-10-01T10:00:00Z'),
		startPaused,
	});
	voices.push(voice);

	return {
		voice,
		store,
		voiceDir,
		targets,
		ownerIn,
		ownerOut: () => ownerOut,
		closed: () => closed,
		events: (index = -1) => {
			const events = linkEvents.at(index);

			if (!events) {
				throw new Error('no link opened');
			}

			return events;
		},
		status: () => JSON.parse(readFileSync(join(voiceDir, 'discord-status.json'), 'utf8')),
	};
};

describe('startDiscordVoice', () => {
	it('not set up → no link, no presence', () => {
		const t = start({ isSetUp: false });

		expect(t.targets).toEqual([]);
		expect(t.store.state.discord).toBeNull();
	});

	it('a config without its token → no link', () =>
		expect(start({ hasToken: false }).targets).toEqual([]));

	it('set up → joins the configured channel for the owner; presence shows it, not yet connected', () => {
		const t = start();

		expect(t.targets).toEqual([
			expect.objectContaining({ token: 'bot-token', guild: 'g1', channel: 'c1', owner: 'u1' }),
		]);
		expect(t.store.state.discord).toEqual({
			isConnected: false,
			isOwnerIn: false,
			isHearing: false,
			channelName: 'Voice OS',
			mode: 'hands-free',
		});
	});

	it('connected, owner joins → heard in the saved mode; the status file says so', () => {
		const t = start();

		t.events().onConnected(true);
		t.events().onOwner(true);

		expect(t.ownerIn).toEqual(['hands-free']);
		expect(t.voice.isOwnerIn()).toBe(true);
		expect(t.store.state.discord?.isOwnerIn).toBe(true);
		expect(t.status()).toEqual({
			connected: true,
			owner_in_channel: true,
			error: '',
			at: '2026-10-01T10:00:00.000Z',
		});
	});

	it('the link drops → the reason in the status file, the owner out', () => {
		const t = start();

		t.events().onConnected(true);
		t.events().onOwner(true);
		t.events().onConnected(false, 'voice disconnected');

		expect(t.ownerOut()).toBe(1);
		expect(t.status()).toMatchObject({
			connected: false,
			owner_in_channel: false,
			error: 'voice disconnected',
		});
	});

	it('a mode chosen → saved, shown, and heard in it at once', () => {
		const t = start();

		t.events().onOwner(true);
		t.voice.setMode('on-demand');

		expect(t.ownerIn).toEqual(['hands-free', 'on-demand']);
		expect(t.store.state.discord?.mode).toBe('on-demand');
		expect(JSON.parse(readFileSync(join(t.voiceDir, 'discord-mode.json'), 'utf8'))).toEqual({
			mode: 'on-demand',
		});
	});

	it('discord off (the config gone) → link closed, owner out, presence cleared', () => {
		const t = start();

		t.events().onOwner(true);
		rmSync(join(t.voiceDir, 'discord.json'));
		t.voice.reload();

		expect(t.closed()).toBe(1);
		expect(t.ownerOut()).toBe(1);
		expect(t.store.state.discord).toBeNull();
	});

	it('the same setup read again → the link kept', () => {
		const t = start();

		t.voice.reload();

		expect(t.targets).toHaveLength(1);
		expect(t.closed()).toBe(0);
	});

	it('a saved mode → heard in it from the start', () => {
		const t = start({ savedMode: 'on-demand' });

		t.events().onOwner(true);

		expect(t.store.state.discord?.mode).toBe('on-demand');
		expect(t.ownerIn).toEqual(['on-demand']);
	});

	it('a mode chosen while the owner is out → saved and shown, nobody listened to', () => {
		const t = start();

		t.voice.setMode('on-demand');

		expect(t.ownerIn).toEqual([]);
		expect(t.store.state.discord?.mode).toBe('on-demand');
	});

	it('listening gave up → shown as not hearing; a mode chosen → hearing again', () => {
		const t = start();

		t.events().onOwner(true);
		t.voice.send({ type: 'listen_off', reason: 'the speech stream keeps dropping' });
		expect(t.store.state.discord?.isHearing).toBe(false);

		t.voice.setMode('hands-free');
		expect(t.store.state.discord?.isHearing).toBe(true);
	});

	it('another channel set up → the old link closed, the owner out, the new channel joined', () => {
		const t = start();

		t.events().onOwner(true);
		writeFileSync(
			join(t.voiceDir, 'discord.json'),
			JSON.stringify({ ...SETUP, channel: 'c2', channel_name: 'Standup' }),
		);
		t.voice.reload();

		expect(t.closed()).toBe(1);
		expect(t.ownerOut()).toBe(1);
		expect(t.targets.map((target) => target.channel)).toEqual(['c1', 'c2']);
		expect(t.store.state.discord?.channelName).toBe('Standup');
	});

	it('the old link reporting after a new setup → ignored', () => {
		const t = start();

		writeFileSync(join(t.voiceDir, 'discord.json'), JSON.stringify({ ...SETUP, channel: 'c2' }));
		t.voice.reload();
		t.events(-1).onConnected(true);
		t.events(0).onConnected(false, 'login failed');
		t.events(0).onOwner(true);

		expect(t.store.state.discord?.isConnected).toBe(true);
		expect(t.status().error).toBe('');
		expect(t.ownerIn).toEqual([]);
	});

	it('voice off → the bot leaves the channel, the owner out, crew told why; back on → joins again', () => {
		const t = start();

		t.events().onConnected(true);
		t.events().onOwner(true);
		t.voice.pause();

		expect(t.closed()).toBe(1);
		expect(t.ownerOut()).toBe(1);
		expect(t.voice.isOwnerIn()).toBe(false);
		expect(t.store.state.discord).toMatchObject({ isConnected: false, isOwnerIn: false });
		expect(t.status()).toMatchObject({ connected: false, error: 'voice off' });

		t.voice.resume();

		expect(t.targets).toHaveLength(2);
		expect(t.status()).toMatchObject({ error: '' });
	});

	it('voice off at boot → never joins; a setup changed meanwhile → recorded, joined once back on', () => {
		const t = start({ startPaused: true });

		expect(t.targets).toEqual([]);
		expect(t.store.state.discord).toMatchObject({ isConnected: false, channelName: 'Voice OS' });

		writeFileSync(
			join(t.voiceDir, 'discord.json'),
			JSON.stringify({ ...SETUP, channel: 'c2', channel_name: 'Standup' }),
		);
		t.voice.reload();
		expect(t.targets).toEqual([]);

		t.voice.resume();
		expect(t.targets).toEqual([expect.objectContaining({ channel: 'c2' })]);
	});

	it('stopped → the status file no longer says connected', () => {
		const t = start();

		t.events().onConnected(true);
		t.events().onOwner(true);
		t.voice.stop();

		expect(t.status()).toMatchObject({ connected: false, owner_in_channel: false });
	});

	it('crew writes the setup while running → joined without a restart; removed → left', async () => {
		const t = start({ isSetUp: false });
		const file = join(t.voiceDir, 'discord.json');

		const waitFor = async (isDone: () => boolean) => {
			for (let tries = 0; tries < 40 && !isDone(); tries++) {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		};

		// As crew writes it: a temporary file renamed over.
		writeFileSync(`${file}.tmp`, JSON.stringify(SETUP));
		renameSync(`${file}.tmp`, file);
		await waitFor(() => t.targets.length === 1);
		expect(t.targets).toHaveLength(1);

		rmSync(file);
		await waitFor(() => t.store.state.discord === null);
		expect(t.store.state.discord).toBeNull();
	});
});

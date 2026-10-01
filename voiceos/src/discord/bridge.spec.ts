import { describe, expect, it } from 'bun:test';
import { createChimeSamples } from '../web/pcm.js';
import { FRAME_SAMPLES } from './audio.js';
import { type ClipSink, DiscordBridge, SILENCE_AFTER_MS, type VoiceLink } from './bridge.js';
import type { OpusCodec } from './codec.js';

// 20 ms of 24 kHz mono: one 48 kHz stereo frame once raised.
const SPEECH_FRAME = new Uint8Array(FRAME_SAMPLES);

interface FakeClip extends ClipSink {
	packets: Uint8Array[];
	isEnded: boolean;
}

const setup = () => {
	const heard: Uint8Array[] = [];
	const owner: boolean[] = [];
	const done: string[] = [];
	const modes: string[] = [];
	const listenOffs: string[] = [];
	const clips: FakeClip[] = [];
	let stops = 0;
	let tick: (() => void) | null = null;
	let now = 1_000;

	// A packet is 1 for a frame with sound in it, 0 for silence; a packet [0xff] does not decode, any
	// other gives back four stereo samples [L, R] = [10, 30].
	const codec: OpusCodec = {
		encode: (frame) => new Uint8Array([frame.some((byte) => byte !== 0) ? 1 : 0]),
		decode: (packet) => {
			if (packet[0] === 0xff) {
				throw new Error('corrupt');
			}

			return new Uint8Array(new Int16Array([10, 30, 10, 30, 10, 30, 10, 30]).buffer);
		},
	};
	const link: VoiceLink = {
		startClip: () => {
			const clip: FakeClip = {
				packets: [],
				isEnded: false,
				push: (packet) => clip.packets.push(packet),
				end: () => {
					clip.isEnded = true;
				},
			};
			clips.push(clip);

			return clip;
		},
		stopPlayback: () => {
			stops++;
		},
		close: () => {},
	};
	const bridge = new DiscordBridge({
		codec,
		onAudio: (mono) => heard.push(mono),
		onOwner: (isIn) => owner.push(isIn),
		onConnected: () => {},
		onClipDone: (id) => done.push(id),
		onMode: (mode) => modes.push(mode),
		onListenOff: (reason) => listenOffs.push(reason),
		setTimer: (run) => {
			tick = run;

			return 1;
		},
		clearTimer: () => {
			tick = null;
		},
		now: () => now,
	});

	bridge.attach(link);

	return {
		bridge,
		heard,
		owner,
		done,
		modes,
		listenOffs,
		clips,
		stops: () => stops,
		tick: () => tick?.(),
		hasTimer: () => tick !== null,
		advance: (ms: number) => {
			now += ms;
		},
	};
};

const audio = (id: string, isLast = false, extra = {}) => ({
	type: 'audio' as const,
	id,
	base64: Buffer.from(isLast ? new Uint8Array(0) : SPEECH_FRAME).toString('base64'),
	isLast,
	...extra,
});

describe('DiscordBridge: the owner', () => {
	it('joins → told once; a packet → decoded and folded to mono', () => {
		const t = setup();

		t.bridge.events.onOwner(true);
		t.bridge.events.onOwner(true);
		t.bridge.events.onOwnerPacket(new Uint8Array([1]));

		expect(t.owner).toEqual([true]);
		expect([...new Int16Array(t.heard[0]?.slice().buffer ?? new ArrayBuffer(0))]).toEqual([
			20, 20, 20, 20,
		]);
	});

	it('a packet that does not decode → skipped, the next one heard', () => {
		const t = setup();

		t.bridge.events.onOwner(true);
		t.bridge.events.onOwnerPacket(new Uint8Array([0xff]));
		t.bridge.events.onOwnerPacket(new Uint8Array([1]));

		expect(t.heard).toHaveLength(1);
	});

	it('a packet while the owner is out → nothing heard', () => {
		const t = setup();

		t.bridge.events.onOwnerPacket(new Uint8Array([1]));

		expect(t.heard).toEqual([]);
	});

	it('quiet past the gap → silence frames, so a turn can end; speaking again → none', () => {
		const t = setup();

		t.bridge.events.onOwner(true);
		t.advance(SILENCE_AFTER_MS - 1);
		t.tick();
		expect(t.heard).toEqual([]);

		t.advance(1);
		t.tick();
		expect(t.heard.map((chunk) => chunk.byteLength)).toEqual([FRAME_SAMPLES * 2]);

		t.bridge.events.onOwnerPacket(new Uint8Array([1]));
		t.tick();
		expect(t.heard).toHaveLength(2);
	});

	it('leaves, or the link drops → told, and the silence stops', () => {
		const t = setup();

		t.bridge.events.onOwner(true);
		t.bridge.events.onConnected(false, 'voice disconnected');

		expect(t.owner).toEqual([true, false]);
		expect(t.hasTimer()).toBe(false);
	});
});

describe('DiscordBridge: speech out', () => {
	it('owner out → not taken, so VoiceOut cuts the clip', () =>
		expect(setup().bridge.send(audio('a'))).toBe(false));

	it('a clip → one stream of Opus frames, ended on the last chunk; idle after that → clip done', () => {
		const t = setup();

		t.bridge.events.onOwner(true);
		expect(t.bridge.send(audio('a'))).toBe(true);
		t.bridge.send(audio('a'));
		t.bridge.events.onPlaybackIdle();
		expect(t.done).toEqual([]);

		t.bridge.send(audio('a', true));
		t.bridge.events.onPlaybackIdle();

		expect(t.clips).toHaveLength(1);
		expect(t.clips[0]?.packets).toHaveLength(2);
		expect(t.clips[0]?.isEnded).toBe(true);
		expect(t.done).toEqual(['a']);
	});

	it('a chime → its frames ahead of the speech', () => {
		const t = setup();

		t.bridge.events.onOwner(true);
		t.bridge.send(audio('a', false, { hasChime: true }));

		// 24 kHz samples become 48 kHz stereo: 8 bytes each, 3840 to a frame.
		const chimeFrames = Math.floor((createChimeSamples(24_000).length * 8) / 3840);
		const kinds = t.clips[0]?.packets.map((packet) => packet[0]);

		// The chime fades out to silence, so only its start is sure to sound.
		expect(kinds).toHaveLength(chimeFrames + 1);
		expect(kinds?.[0]).toBe(1);
		expect(kinds?.at(-1)).toBe(0);
	});

	it('no chime → the speech alone', () => {
		const t = setup();

		t.bridge.events.onOwner(true);
		t.bridge.send(audio('a'));

		expect(t.clips[0]?.packets).toEqual([new Uint8Array([0])]);
	});

	it('a part frame at the end → padded and sent before the clip ends', () => {
		const t = setup();
		const half = {
			...audio('a'),
			base64: Buffer.from(new Uint8Array(FRAME_SAMPLES / 2).fill(1)).toString('base64'),
		};

		t.bridge.events.onOwner(true);
		t.bridge.send(half);
		expect(t.clips[0]?.packets).toEqual([]);

		t.bridge.send(audio('a', true));

		expect(t.clips[0]?.packets).toEqual([new Uint8Array([1])]);
		expect(t.clips[0]?.isEnded).toBe(true);
	});

	it('the next clip while one plays → the first ended, never reported done', () => {
		const t = setup();

		t.bridge.events.onOwner(true);
		t.bridge.send(audio('a'));
		t.bridge.send(audio('b'));
		t.bridge.send(audio('b', true));
		t.bridge.events.onPlaybackIdle();

		expect(t.clips.map((clip) => clip.isEnded)).toEqual([true, true]);
		expect(t.done).toEqual(['b']);
	});

	it('audio_cancel → playback stopped, no clip done', () => {
		const t = setup();

		t.bridge.events.onOwner(true);
		t.bridge.send(audio('a'));
		t.bridge.send({ type: 'audio_cancel', id: 'a' });
		t.bridge.events.onPlaybackIdle();

		expect(t.stops()).toBe(1);
		expect(t.done).toEqual([]);
	});

	it('a cancel for another clip → ignored', () => {
		const t = setup();

		t.bridge.events.onOwner(true);
		t.bridge.send(audio('a'));
		t.bridge.send({ type: 'audio_cancel', id: 'b' });

		expect(t.stops()).toBe(0);
	});
});

describe('DiscordBridge: other messages', () => {
	it('listen_on → the mode handed on; push to talk by voice and page messages → not taken', () => {
		const t = setup();

		expect(t.bridge.send({ type: 'listen_on', mode: 'on-demand' })).toBe(true);
		expect(t.bridge.send({ type: 'listen_off', reason: 'turned off by voice' })).toBe(false);
		expect(t.bridge.send({ type: 'heard_ignored' })).toBe(false);
		expect(t.modes).toEqual(['on-demand']);
		expect(t.listenOffs).toEqual([]);
	});

	it('listening gave up → taken and reported, so the page can say it is not hearing', () => {
		const t = setup();

		expect(t.bridge.send({ type: 'listen_off', reason: 'the speech stream keeps dropping' })).toBe(
			true,
		);
		expect(t.listenOffs).toEqual(['the speech stream keeps dropping']);
	});

	it('no link yet → speech not taken', () => {
		const bridge = new DiscordBridge({
			codec: { encode: (frame) => frame, decode: (packet) => packet },
			onAudio: () => {},
			onOwner: () => {},
			onConnected: () => {},
			onClipDone: () => {},
			onMode: () => {},
			onListenOff: () => {},
			setTimer: () => 1,
			clearTimer: () => {},
		});

		bridge.events.onOwner(true);

		expect(bridge.send(audio('a'))).toBe(false);
	});
});

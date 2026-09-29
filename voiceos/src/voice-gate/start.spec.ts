import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VoiceGateStatus } from '../shared/protocol.js';
import type { Models } from './models.js';
import { type StartVoiceGateParams, startVoiceGate } from './start.js';
import { captureLog, DEVELOPER, fakeEmbed, fakeVads, gradedEmbed, pcm } from './test-support.js';
import { PACK_MANIFEST } from './pack.js';
import { saveVoiceprint, VOICEPRINT_LENGTH } from './voiceprint-store.js';

let root: string;
let statuses: VoiceGateStatus[];
let fetched: string[];
let readLog: () => Record<string, unknown>[];

const fakeModels = (): Promise<Models> =>
	Promise.resolve({ createVad: fakeVads().createVad, embed: fakeEmbed });

const start = (overrides: Partial<StartVoiceGateParams> = {}) =>
	startVoiceGate({
		root,
		voiceprintFile: join(root, 'voiceos', 'voiceprint.json'),
		env: {},
		setStatus: (status) => statuses.push(status),
		now: () => Date.now(),
		isVoiceOsSpeaking: () => false,
		loadModels: fakeModels,
		fetch: ((url: string) => {
			fetched.push(url);

			return Promise.resolve(new Response('missing', { status: 404 }));
		}) as unknown as typeof fetch,
		platform: 'linux',
		arch: 'arm64',
		...overrides,
	});

const settled = async (): Promise<VoiceGateStatus | undefined> => {
	for (let tries = 0; tries < 100 && statuses.at(-1)?.phase === 'preparing'; tries++) {
		await Bun.sleep(5);
	}

	return statuses.at(-1);
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'voice-gate-start-'));
	statuses = [];
	fetched = [];
	readLog = captureLog();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('startVoiceGate', () => {
	it('a pack already on disk → models loaded, learning begins', async () => {
		const loaded: string[] = [];
		const handle = start({
			env: { VOICEOS_VOICE_GATE_PACK_DIR: '/packs/here' },
			loadModels: (dir) => {
				loaded.push(dir);

				return fakeModels();
			},
		});

		expect(await settled()).toEqual({ phase: 'learning', seconds: 0, of: 30 });
		expect(statuses[0]).toEqual({ phase: 'preparing', isDownloading: false });
		expect(loaded).toEqual(['/packs/here']);
		expect(fetched).toEqual([]);
		handle.stop();
	});

	it('no pack for this platform (an Intel Mac) → unavailable, nothing downloaded', async () => {
		start({ platform: 'darwin', arch: 'x64' });

		expect(await settled()).toEqual({ phase: 'unavailable' });
		expect(fetched).toEqual([]);
	});

	it('the download fails → shown downloading, then unavailable, the reason logged', async () => {
		start();

		expect(await settled()).toEqual({ phase: 'unavailable' });
		expect(statuses).toContainEqual({ phase: 'preparing', isDownloading: true });
		expect(fetched).toHaveLength(1);
		expect(readLog().find((line) => line.msg === 'unavailable')?.error).toContain('404');
	});

	it('the models fail to load → unavailable; voice calls still do nothing, never throw', async () => {
		const handle = start({
			env: { VOICEOS_VOICE_GATE_PACK_DIR: '/packs/here' },
			loadModels: () => Promise.reject(new Error('dlopen failed')),
		});

		expect(await settled()).toEqual({ phase: 'unavailable' });
		handle.observe('c1', pcm(DEVELOPER, 100), 16_000);
		handle.turnDelivered('c1', { from: 0, to: 1, source: 'push' });
		handle.forget('c1');
		expect(statuses.at(-1)).toEqual({ phase: 'unavailable' });
	});

	it('models loaded → audio and heard turns reach the gate; words no mic heard do not', async () => {
		const from = Date.now();
		const handle = start({ env: { VOICEOS_VOICE_GATE_PACK_DIR: '/packs/here' } });

		await settled();

		for (let chunk = 0; chunk < 10; chunk++) {
			handle.observe('c1', pcm(DEVELOPER, 100), 16_000);
		}

		handle.turnDelivered('c1', null);
		handle.turnDelivered('c1', { from, to: Date.now() + 1000, source: 'push' });

		for (let tries = 0; tries < 100 && !readLog().some((line) => line.msg === 'learn'); tries++) {
			await Bun.sleep(5);
		}

		expect(readLog().filter((line) => line.msg === 'learn')).toHaveLength(1);
		expect(readLog().some((line) => line.msg === 'turn not read')).toBe(false);
		handle.stop();
	});

	it('VOICEOS_VOICE_GATE=0 → off: no status, no download, no models', async () => {
		let isLoaded = false;
		const handle = start({
			env: { VOICEOS_VOICE_GATE: '0' },
			loadModels: () => {
				isLoaded = true;

				return fakeModels();
			},
		});

		await Bun.sleep(20);
		handle.observe('c1', pcm(DEVELOPER, 100), 16_000);
		expect(statuses).toEqual([]);
		expect(fetched).toEqual([]);
		expect(isLoaded).toBe(false);
	});

	it('audio before the models are ready → ignored', () => {
		const handle = start({
			env: { VOICEOS_VOICE_GATE_PACK_DIR: '/packs/here' },
			loadModels: () => new Promise(() => {}),
		});

		handle.observe('c1', pcm(DEVELOPER, 100), 16_000);
		handle.turnDelivered('c1', { from: 0, to: 1, source: 'push' });
		expect(statuses).toEqual([{ phase: 'preparing', isDownloading: false }]);
	});

	it('a voice saved by an earlier run → scoring as soon as the models load, with its average', async () => {
		const voiceprint = new Float32Array(VOICEPRINT_LENGTH).fill(1);

		saveVoiceprint(join(root, 'voiceos', 'voiceprint.json'), {
			packId: PACK_MANIFEST.id,
			voiceprint,
			enrolled: voiceprint,
			recentScores: [0.8, 0.9],
			turns: 2,
			updatedAt: 'then',
		});

		const handle = start({ env: { VOICEOS_VOICE_GATE_PACK_DIR: '/packs/here' } });

		expect(await settled()).toEqual({
			phase: 'scoring',
			lastScore: null,
			turnScore: null,
			average: 0.85,
			isTrained: false,
		});
		expect(statuses.some((status) => status.phase === 'learning')).toBe(false);
		expect(readLog().find((line) => line.msg === 'voiceprint loaded')).toMatchObject({ turns: 2 });
		handle.stop();
	});

	it('a voiceprint this Voice OS cannot read → ignored and left until a new voice is saved over it', async () => {
		const file = join(root, 'voiceos', 'voiceprint.json');

		mkdirSync(join(root, 'voiceos'), { recursive: true });
		writeFileSync(file, JSON.stringify({ version: 2 }));

		const handle = start({ env: { VOICEOS_VOICE_GATE_PACK_DIR: '/packs/here' } });

		expect(await settled()).toEqual({ phase: 'learning', seconds: 0, of: 30 });
		expect(readLog().find((line) => line.msg === 'voiceprint ignored')?.reason).toContain(
			'version 2',
		);
		expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 2 });
		handle.stop();
	});

	it('forget my voice → reaches the gate: the saved file is gone, learning from zero', async () => {
		const file = join(root, 'voiceos', 'voiceprint.json');
		const voiceprint = new Float32Array(VOICEPRINT_LENGTH).fill(1);

		saveVoiceprint(file, {
			packId: PACK_MANIFEST.id,
			voiceprint,
			enrolled: voiceprint,
			recentScores: [],
			turns: 0,
			updatedAt: 'then',
		});

		const handle = start({ env: { VOICEOS_VOICE_GATE_PACK_DIR: '/packs/here' } });

		await settled();
		handle.forgetVoice();

		expect(existsSync(file)).toBe(false);
		expect(statuses.at(-1)).toEqual({ phase: 'learning', seconds: 0, of: 30 });
		handle.stop();
	});

	it('a voice learned through the handle → saved with this pack’s id; the next start resumes scoring', async () => {
		let clock = 1_000_000;
		const file = join(root, 'voiceos', 'voiceprint.json');
		const models = (): Promise<Models> =>
			Promise.resolve({ createVad: fakeVads().createVad, embed: gradedEmbed });
		const first = start({
			env: { VOICEOS_VOICE_GATE_PACK_DIR: '/packs/here' },
			loadModels: models,
			now: () => clock,
		});

		await settled();

		for (let turn = 0; turn < 8 && !existsSync(file); turn++) {
			const from = clock;

			for (let chunk = 0; chunk < 46; chunk++) {
				first.observe('c1', pcm(chunk < 40 ? DEVELOPER : 0.01, 100), 16_000);
				clock += 100;
			}

			const learned = readLog().filter((line) => line.msg === 'learn').length;

			first.turnDelivered('c1', { from, to: clock, source: 'push' });

			for (
				let tries = 0;
				tries < 200 && readLog().filter((line) => line.msg === 'learn').length === learned;
				tries++
			) {
				await Bun.sleep(5);
			}
		}

		first.stop();
		expect(JSON.parse(readFileSync(file, 'utf8')).packId).toBe(PACK_MANIFEST.id);

		statuses = [];

		const second = start({
			env: { VOICEOS_VOICE_GATE_PACK_DIR: '/packs/here' },
			loadModels: models,
			now: () => clock,
		});

		expect(await settled()).toMatchObject({ phase: 'scoring' });
		second.stop();
	});

	it('recording not asked for → no folder made, nothing recorded', async () => {
		const recordingsDir = join(root, 'voiceos', 'voice-recordings');
		const handle = start({
			env: { VOICEOS_VOICE_GATE_PACK_DIR: '/packs/here' },
			recordingsDir,
			isRecording: false,
		});

		await settled();

		for (let chunk = 0; chunk < 20; chunk++) {
			handle.observe('c1', pcm(DEVELOPER, 100), 16_000);
		}

		expect(existsSync(recordingsDir)).toBe(false);
		handle.stop();
	});

	it('recording asked for → the folder made and said, with what is already in it', async () => {
		const recordingsDir = join(root, 'voiceos', 'voice-recordings');
		const handle = start({
			env: { VOICEOS_VOICE_GATE_PACK_DIR: '/packs/here' },
			recordingsDir,
			isRecording: true,
		});

		await settled();

		expect(existsSync(recordingsDir)).toBe(true);
		expect(readLog().find((line) => line.msg === 'recording voice')).toMatchObject({ files: 0 });
		handle.stop();
	});

	it('recording off but recordings left from before → said at start, so they are not forgotten', async () => {
		const recordingsDir = join(root, 'voiceos', 'voice-recordings');

		mkdirSync(recordingsDir, { recursive: true });
		writeFileSync(join(recordingsDir, 'old.wav'), 'x');

		const handle = start({
			env: { VOICEOS_VOICE_GATE_PACK_DIR: '/packs/here' },
			recordingsDir,
			isRecording: false,
		});

		await settled();

		expect(readLog().find((line) => line.msg === 'voice recordings kept')).toMatchObject({
			files: 1,
		});
		handle.stop();
	});

	it('recording on, speech and a turn → a labelled recording on disk once the wait is over', async () => {
		let clock = 1_000_000;
		const recordingsDir = join(root, 'voiceos', 'voice-recordings');
		const handle = start({
			env: { VOICEOS_VOICE_GATE_PACK_DIR: '/packs/here' },
			recordingsDir,
			isRecording: true,
			recordingWaitMs: 50,
			now: () => clock,
		});

		await settled();

		const from = clock;

		for (let chunk = 0; chunk < 26; chunk++) {
			handle.observe('c1', pcm(chunk < 20 ? DEVELOPER : 0.01, 100), 16_000);
			clock += 100;
		}

		handle.turnDelivered('c1', { from, to: clock, source: 'push', text: 'run the tests' });
		clock += 1_000;

		for (
			let tries = 0;
			tries < 200 && !readdirSync(recordingsDir).some((name) => name.endsWith('.json'));
			tries++
		) {
			// The recorder's own clock moves on while it waits for a turn to claim the segment.
			clock += 100;
			await Bun.sleep(50);
		}

		const [name] = readdirSync(recordingsDir).filter((file) => file.endsWith('.json'));

		expect(name).toContain('-turn');
		handle.stop();
	}, 30_000);
});

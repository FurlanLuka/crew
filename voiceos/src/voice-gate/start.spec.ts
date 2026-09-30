import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VoiceGateStatus } from '../shared/protocol.js';
import type { Models } from './models.js';
import { type StartVoiceGateParams, startVoiceGate } from './start.js';
import { captureLog, fakeEmbed, fakeVads, pcm, DEVELOPER } from './test-support.js';

let root: string;
let statuses: VoiceGateStatus[];
let fetched: string[];
let readLog: () => Record<string, unknown>[];

const fakeModels = (): Promise<Models> =>
	Promise.resolve({ createVad: fakeVads().createVad, embed: fakeEmbed });

const start = (overrides: Partial<StartVoiceGateParams> = {}) =>
	startVoiceGate({
		root,
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
});

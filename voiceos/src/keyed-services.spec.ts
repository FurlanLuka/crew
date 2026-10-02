import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePaths, type Keys } from './config.js';
import {
	buildKeyedServices,
	holdKeyedServices,
	type KeyedServicesHolder,
} from './keyed-services.js';
import { configureLog } from './log.js';
import { UtteranceRouter, type KernelHandler } from './router/router.js';
import { Store } from './state/store.js';
import { englishJudge } from '../test/support/english-judge.js';

configureLog({ quiet: true });

// No key in the environment: the files are the only source, as on a fresh machine.
const NO_ENV = {};

const createPaths = () => {
	const home = mkdtempSync(join(tmpdir(), 'voiceos-keys-'));

	return resolvePaths({ HOME: home, VOICEOS_KEYS_DIR: join(home, 'keys') });
};

const until = async (isDone: () => boolean, what: string): Promise<void> => {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (isDone()) {
			return;
		}

		await Bun.sleep(10);
	}

	throw new Error(`timed out waiting for ${what}`);
};

const holders: Pick<KeyedServicesHolder<unknown>, 'stop'>[] = [];

afterEach(() => {
	for (const holder of holders.splice(0)) {
		holder.stop();
	}
});

describe('buildKeyedServices', () => {
	it('no keys → no voice, no kernel; the judge and narrator answer without a model', async () => {
		const services = buildKeyedServices({
			keys: { anthropic: null, soniox: null },
			createKernel: () => 'kernel',
		});

		expect(services.tts).toBeNull();
		expect(services.kernel).toBeNull();
		expect(await services.judge({ key: 'bare_answer', utterance: 'yes' })).toBe('unclear');
	});

	it('both keys → a voice and a kernel built with the judge beside it', () => {
		let kernelJudge: unknown = null;
		const services = buildKeyedServices({
			keys: { anthropic: 'sk-ant', soniox: 'sk-son' },
			createKernel: (apiKey, judge) => {
				kernelJudge = judge;

				return `kernel:${apiKey}`;
			},
		});

		expect(services.tts).not.toBeNull();
		expect(services.kernel).toBe('kernel:sk-ant');
		expect(kernelJudge).toBe(services.judge);
	});

	it('one key changed → only what it builds is new; the rest is the same object', () => {
		const createKernel = (apiKey: string) => ({ apiKey });
		const first = buildKeyedServices({
			keys: { anthropic: 'sk-ant', soniox: 'sk-son' },
			createKernel,
		});
		const anthropicOnly = buildKeyedServices({
			keys: { anthropic: 'sk-ant-2', soniox: 'sk-son' },
			createKernel,
			previous: first,
		});

		expect(anthropicOnly.tts).toBe(first.tts);
		expect(anthropicOnly.kernel).toEqual({ apiKey: 'sk-ant-2' });
		expect(anthropicOnly.judge).not.toBe(first.judge);

		const sonioxOnly = buildKeyedServices({
			keys: { anthropic: 'sk-ant-2', soniox: 'sk-son-2' },
			createKernel,
			previous: anthropicOnly,
		});

		expect(sonioxOnly.tts).not.toBe(anthropicOnly.tts);
		expect(sonioxOnly.kernel).toBe(anthropicOnly.kernel);
		expect(sonioxOnly.judge).toBe(anthropicOnly.judge);
		expect(sonioxOnly.narrate).toBe(anthropicOnly.narrate);
		expect(sonioxOnly.writeAbout).toBe(anthropicOnly.writeAbout);
	});
});

describe('holdKeyedServices', () => {
	it('booted without keys → both saved while running → the next utterance reaches the kernel', async () => {
		const paths = createPaths();
		const changes: Keys[] = [];
		const kernelCalls: string[] = [];

		const kernel: KernelHandler = async (text) => {
			kernelCalls.push(text);

			return { reply: '', did: [], calls: [] };
		};

		const services = holdKeyedServices({
			paths,
			env: NO_ENV,
			build: (keys) => ({ keys, kernel: keys.anthropic ? kernel : null }),
			onChange: (next) => changes.push(next.keys),
		});

		holders.push(services);

		const store = new Store();
		const router = new UtteranceRouter({
			store,
			judge: englishJudge,
			get kernel() {
				return services.current.kernel;
			},
			now: () => 1,
		});

		await router.handle('what is waiting?');
		expect(kernelCalls).toEqual([]);
		expect(store.state.spoken.at(-1)?.text).toContain('Anthropic key');

		writeFileSync(join(paths.keysDir, 'anthropic.key'), 'sk-ant-new\n', { mode: 0o600 });
		writeFileSync(join(paths.keysDir, 'soniox.key'), 'sk-son-new\n', { mode: 0o600 });
		await until(() => services.current.keys.soniox === 'sk-son-new', 'both keys read');

		await router.handle('what is waiting?');

		expect(kernelCalls).toEqual(['what is waiting?']);
		expect(changes.at(-1)).toEqual({ anthropic: 'sk-ant-new', soniox: 'sk-son-new' });
	});

	it('nothing changed → nothing rebuilt; a key replaced → rebuilt with the old let go', () => {
		const paths = createPaths();
		const released: string[] = [];
		let builds = 0;

		mkdirSync(paths.keysDir, { recursive: true });

		const services = holdKeyedServices({
			paths,
			env: NO_ENV,
			isWatched: false,
			build: (keys) => {
				builds++;

				return { keys, id: `build-${builds}` };
			},
			onChange: (_next, previous) => released.push(previous.id),
		});

		expect(services.reload()).toBe(false);
		expect(builds).toBe(1);

		writeFileSync(join(paths.keysDir, 'soniox.key'), 'sk-son\n');
		expect(services.reload()).toBe(true);
		expect(services.current.id).toBe('build-2');
		expect(released).toEqual(['build-1']);
	});
});

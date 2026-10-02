// Everything that needs the Anthropic or Soniox key, built from the keys at hand and built again when
// a key file changes (Set up's keys sheet, or `crew server keys set` in a terminal): a key added to a
// running Voice OS is heard on the next utterance, with no restart.
import { mkdirSync, watch } from 'node:fs';
import { loadKeys, type Keys, type Paths } from './config.js';
import { createJudge, type Judge } from './judge/judge.js';
import { createLogger } from './log.js';
import { createAboutWriter, type WriteAbout } from './narrator/about.js';
import { createNarrator, type NarrateFunction } from './narrator/narrator.js';
import { SonioxTts } from './speech/tts.js';
import { createVoiceLineWriter, type VoiceLineWriter } from './voice-lines/writer.js';

const log = createLogger('keys');

const KEY_FILES = new Set(['anthropic.key', 'soniox.key']);
const SETTLE_MS = 150;

export interface KeyedServices<K> {
	keys: Keys;
	tts: SonioxTts | null;
	judge: Judge;
	narrate: NarrateFunction;
	writeAbout: WriteAbout;
	voiceLines: VoiceLineWriter;
	kernel: K | null;
}

export interface BuildKeyedServicesParams<K> {
	keys: Keys;
	// The kernel's tools close over the judge built beside it.
	createKernel: (apiKey: string, judge: Judge) => K;
	// What the keys built last time: whatever a key that did not change built is kept as it is (an open
	// TTS socket, a kernel mid-turn).
	previous?: KeyedServices<K> | null;
}

type AnthropicServices<K> = Pick<
	KeyedServices<K>,
	'judge' | 'narrate' | 'writeAbout' | 'voiceLines' | 'kernel'
>;

const buildAnthropicServices = <K>(
	apiKey: string | null,
	createKernel: (apiKey: string, judge: Judge) => K,
): AnthropicServices<K> => {
	const judge = createJudge({ apiKey });

	return {
		judge,
		narrate: createNarrator(apiKey),
		writeAbout: createAboutWriter(apiKey),
		voiceLines: createVoiceLineWriter({ apiKey }),
		kernel: apiKey ? createKernel(apiKey, judge) : null,
	};
};

export const buildKeyedServices = <K>({
	keys,
	createKernel,
	previous = null,
}: BuildKeyedServicesParams<K>): KeyedServices<K> => {
	const isSonioxSame = previous !== null && previous.keys.soniox === keys.soniox;
	const isAnthropicSame = previous !== null && previous.keys.anthropic === keys.anthropic;
	const anthropic: AnthropicServices<K> = isAnthropicSame
		? {
				judge: previous.judge,
				narrate: previous.narrate,
				writeAbout: previous.writeAbout,
				voiceLines: previous.voiceLines,
				kernel: previous.kernel,
			}
		: buildAnthropicServices(keys.anthropic, createKernel);

	return {
		keys,
		tts: isSonioxSame ? previous.tts : keys.soniox ? new SonioxTts({ apiKey: keys.soniox }) : null,
		...anthropic,
	};
};

const isSameKeys = (first: Keys, second: Keys): boolean =>
	first.anthropic === second.anthropic && first.soniox === second.soniox;

export interface KeyedServicesHolder<S> {
	readonly current: S;
	// Reads the keys again; true when they changed and the services were rebuilt.
	reload: () => boolean;
	stop: () => void;
}

export interface HoldKeyedServicesParams<S> {
	paths: Paths;
	env?: Record<string, string | undefined>;
	// previous: what the last keys built, for the parts of it a change leaves alone.
	build: (keys: Keys, previous: S | null) => S;
	// After a rebuild: what was replaced is let go here (a TTS socket closed).
	onChange: (next: S, previous: S) => void;
	// Tests drive reload themselves.
	isWatched?: boolean;
}

export const holdKeyedServices = <S extends { keys: Keys }>({
	paths,
	env = process.env,
	build,
	onChange,
	isWatched = true,
}: HoldKeyedServicesParams<S>): KeyedServicesHolder<S> => {
	let current = build(loadKeys(paths, env), null);

	const reload = (): boolean => {
		const keys = loadKeys(paths, env);

		if (isSameKeys(keys, current.keys)) {
			return false;
		}

		const previous = current;

		current = build(keys, previous);
		// Which keys are set, never their values.
		log.info('keys reloaded', { anthropic: Boolean(keys.anthropic), soniox: Boolean(keys.soniox) });
		onChange(current, previous);

		return true;
	};

	let watcher: ReturnType<typeof watch> | null = null;
	let settleTimer: ReturnType<typeof setTimeout> | null = null;

	if (isWatched) {
		try {
			// Made here so a first start with no keys yet still sees the first one saved.
			mkdirSync(paths.keysDir, { recursive: true, mode: 0o700 });
			watcher = watch(paths.keysDir, (_event, file) => {
				if (file && !KEY_FILES.has(file)) {
					return;
				}

				// A save truncates, then writes: read once it has settled.
				if (settleTimer) {
					clearTimeout(settleTimer);
				}

				settleTimer = setTimeout(reload, SETTLE_MS);
			});
		} catch (error) {
			log.warn('keys not watched; a new key needs a restart', { error: String(error) });
		}
	}

	return {
		get current() {
			return current;
		},
		reload,
		stop: () => {
			if (settleTimer) {
				clearTimeout(settleTimer);
			}

			watcher?.close();
		},
	};
};

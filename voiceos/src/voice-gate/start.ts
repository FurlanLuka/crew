// Starts the voice gate's dry run beside Voice OS: gets the models in the background, then hands the
// microphone's audio and the delivered turns to the gate. Nothing here may slow or break voice: until
// the models are loaded, and whenever they failed, every call is a no-op.

import { createLogger } from '../log.js';
import type { VoiceGateStatus } from '../shared/protocol.js';
import { isTrained, rollingAverage } from './adaptation.js';
import type { Embed, Models } from './models.js';
import { ensurePack, PACK_MANIFEST, packFor } from './pack.js';
import { type HeardTurn, type LearnedVoice, VoiceGate, type VoiceStore } from './voice-gate.js';
import { deleteVoiceprint, loadVoiceprint, saveVoiceprint } from './voiceprint-store.js';

const log = createLogger('voice-gate');

const HEALTH_EVERY_MS = 60_000;
const LAG_PROBE_MS = 1_000;

export interface VoiceGateHandle {
	observe: (client: string, chunk: Uint8Array, sampleRate: number) => void;
	// turn: null for words that were not heard (typed, simulated).
	turnDelivered: (client: string, turn: HeardTurn | null) => void;
	forget: (client: string) => void;
	forgetVoice: () => void;
	stop: () => void;
}

export interface StartVoiceGateParams {
	// Where packs are kept (~/.crew/voiceos/voice-gate).
	root: string;
	// The learned voice (~/.crew/voiceos/voiceprint.json).
	voiceprintFile: string;
	env: Record<string, string | undefined>;
	setStatus: (status: VoiceGateStatus) => void;
	now: () => number;
	isVoiceOsSpeaking: () => boolean;
	loadModels: (packDir: string) => Promise<Models>;
	fetch?: typeof fetch;
	platform?: NodeJS.Platform;
	arch?: string;
}

const percentile = (values: number[], share: number): number | null => {
	const sorted = [...values].sort((left, right) => left - right);

	return sorted.length === 0 ? null : (sorted[Math.floor((sorted.length - 1) * share)] ?? null);
};

// The models run on the event loop's thread: how long they take, and how late they make everything
// else, once a minute.
const watchHealth = (embed: Embed): { embed: Embed; stop: () => void } => {
	let embedMs: number[] = [];
	let lagMs: number[] = [];
	let expected = performance.now() + LAG_PROBE_MS;
	const probe = setInterval(() => {
		const now = performance.now();

		lagMs.push(Math.max(0, now - expected));
		expected = now + LAG_PROBE_MS;
	}, LAG_PROBE_MS);
	const report = setInterval(() => {
		if (embedMs.length > 0) {
			log.info('health', {
				embeds: embedMs.length,
				embedMsP50: percentile(embedMs, 0.5),
				embedMsP95: percentile(embedMs, 0.95),
				lagMsP50: percentile(lagMs, 0.5),
				lagMsP95: percentile(lagMs, 0.95),
			});
		}

		embedMs = [];
		lagMs = [];
	}, HEALTH_EVERY_MS);

	probe.unref();
	report.unref();

	return {
		embed: async (audio) => {
			const startedAt = performance.now();
			const embedding = await embed(audio);

			embedMs.push(Math.round(performance.now() - startedAt));

			return embedding;
		},
		stop: () => {
			clearInterval(probe);
			clearInterval(report);
		},
	};
};

const findPackDir = async (params: StartVoiceGateParams): Promise<string | null> => {
	const { env, root, setStatus } = params;
	const platform = params.platform ?? process.platform;
	const arch = params.arch ?? process.arch;

	// A pack already unpacked somewhere (a build from source, the live tests): no download.
	if (env.VOICEOS_VOICE_GATE_PACK_DIR) {
		return env.VOICEOS_VOICE_GATE_PACK_DIR;
	}

	const entry = packFor(platform, arch);

	if (!entry) {
		log.info('unavailable: no voice gate pack for this platform', { platform, arch });

		return null;
	}

	const startedAt = Date.now();
	const pack = await ensurePack({
		root,
		id: PACK_MANIFEST.id,
		entry,
		platform,
		fetch: params.fetch ?? fetch,
		onDownload: () => {
			log.info('pack download start', { url: entry.url });
			setStatus({ phase: 'preparing', isDownloading: true });
		},
	});

	if (pack.downloadedBytes !== null) {
		log.info('pack downloaded', { bytes: pack.downloadedBytes, ms: Date.now() - startedAt });
	}

	return pack.dir;
};

// With VOICEOS_VOICE_GATE_PACK_DIR the pack there is taken to hold the manifest's models.
const createVoiceStore = (file: string): VoiceStore => ({
	save: (voice) =>
		saveVoiceprint(file, {
			...voice,
			packId: PACK_MANIFEST.id,
			updatedAt: new Date().toISOString(),
		}),
	delete: () => deleteVoiceprint(file),
});

const loadVoice = (file: string): LearnedVoice | null => {
	const loaded = loadVoiceprint(file, PACK_MANIFEST.id);

	switch (loaded.kind) {
		case 'none':
			return null;
		case 'ignored':
			// Left on disk until a new voice is learned and saved over it.
			log.warn('voiceprint ignored', { reason: loaded.reason });

			return null;
		case 'found':
			log.info('voiceprint loaded', {
				turns: loaded.record.turns,
				average: rollingAverage(loaded.record.recentScores),
				isTrained: isTrained(loaded.record.recentScores),
			});

			return loaded.record;
	}
};

export const startVoiceGate = (params: StartVoiceGateParams): VoiceGateHandle => {
	let gate: VoiceGate | null = null;
	let stopHealth: (() => void) | null = null;

	// An escape hatch, not a setting: the native runtime shares Voice OS's process.
	if (params.env.VOICEOS_VOICE_GATE === '0') {
		log.info('off: VOICEOS_VOICE_GATE=0');
	} else {
		params.setStatus({ phase: 'preparing', isDownloading: false });

		void (async () => {
			try {
				const packDir = await findPackDir(params);

				if (!packDir) {
					params.setStatus({ phase: 'unavailable' });

					return;
				}

				const startedAt = Date.now();
				const models = await params.loadModels(packDir);
				const health = watchHealth(models.embed);

				stopHealth = health.stop;
				log.info('models loaded', { packDir, ms: Date.now() - startedAt });
				gate = new VoiceGate({
					createVad: models.createVad,
					embed: health.embed,
					setStatus: params.setStatus,
					now: params.now,
					isVoiceOsSpeaking: params.isVoiceOsSpeaking,
					store: createVoiceStore(params.voiceprintFile),
					initial: loadVoice(params.voiceprintFile),
				});
			} catch (error) {
				log.warn('unavailable', { error: String(error) });
				params.setStatus({ phase: 'unavailable' });
			}
		})();
	}

	return {
		observe: (client, chunk, sampleRate) => gate?.observe(client, chunk, sampleRate),
		turnDelivered: (client, turn) => {
			if (!gate || !turn) {
				return;
			}

			gate.turnDelivered(client, turn).catch((error: unknown) => {
				log.warn('turn not read', { client, error: String(error) });
			});
		},
		forget: (client) => gate?.forget(client),
		forgetVoice: () => gate?.forgetVoice(),
		stop: () => stopHealth?.(),
	};
};

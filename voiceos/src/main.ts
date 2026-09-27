import { join } from 'node:path';
import { readMediaFile, sweepMedia } from './sessions/media.js';
import type { OpenUrl } from './tools/docs.js';
import { writeFileSync } from 'node:fs';
import index from './web/index.html';
import {
	ensureToken,
	loadKeys,
	findMissingKeys,
	resolvePaths,
	shouldRecordState,
} from './config.js';
import { CrewAdapter } from './crew/adapter.js';
import { listAllowedOrigins } from './gateway/auth.js';
import { startGateway } from './gateway/server.js';
import { configureLog, createLogger } from './log.js';
import { UtteranceRouter } from './router/router.js';
import { COMMAND_TTL_MS } from './shared/protocol.js';
import { Kernel } from './router/kernel.js';
import {
	LEGACY_SETUP_REF,
	SETUP_ORIENTATION,
	SETUP_REF,
	createSetupWorktree,
} from './sessions/setup-session.js';
import { readHistory } from './memory/journal.js';
import { createDebugNote, saveDebugNote } from './memory/debug-notes.js';
import { createNotesStore, type NotesStore } from './memory/notes.js';
import { toNotesKey } from './shared/notes.js';
import { createAsideNarrator, createTurnNarrator, readGitHead } from './narrator/turn.js';
import { persistTopics } from './memory/topics.js';
import { resolveClaudeBin, isCompiled } from './sessions/claude-bin.js';
import { SessionManager } from './sessions/manager.js';
import { loadTranscript, restoreHistory } from './sessions/history.js';
import { loadRegistry, renameSession } from './sessions/registry.js';
import { Store } from './state/store.js';
import { createHandsFreeSwitch } from './speech/hands-free-switch.js';
import { VoiceInput } from './speech/voice-in.js';
import { VoiceOut } from './speech/voice-out.js';
import { DevWatch } from './dev/watch.js';
import { SonioxTts } from './speech/tts.js';
import { createNarrator } from './narrator/narrator.js';
import { createTopicWriter } from './narrator/topic.js';

const WORKTREE_POLL_MS = 10_000;
const REMINDER_INTERVAL_MS = 30_000;

const paths = resolvePaths();

configureLog({ file: paths.logFile });

const log = createLogger('main');

const token = ensureToken(paths);
const keys = loadKeys(paths);
// Lets a page inject heard words (window.voiceos.say) — demos and screenshots, never by default.
const isSpeechSimulated = process.env.VOICEOS_DEBUG_SPEECH === '1';
const store = new Store();

const claudeBin = resolveClaudeBin({
	override: process.env.VOICEOS_CLAUDE_BIN,
	compiled: isCompiled(),
	which: (command) => Bun.which(command),
});
const missing = findMissingKeys(keys, paths);

if (claudeBin === null) {
	missing.push('claude on PATH (install Claude Code, or set VOICEOS_CLAUDE_BIN)');
}

store.dispatch({ type: 'setup', missing });
log.info('claude executable', { bin: claudeBin ?? 'sdk-bundled' });

renameSession({ file: paths.sessionsFile, from: LEGACY_SETUP_REF, to: SETUP_REF });

const crew = new CrewAdapter();
// Every image a session shows is stored here, by content; /media serves this folder alone.
const mediaDir = join(paths.voiceDir, 'media');
const MEDIA_KEPT_MS = 30 * 24 * 60 * 60 * 1000;
// Before the histories restore: a restore stores again any old picture a stream still shows.
const sweptMedia = sweepMedia({ dir: mediaDir, maxAgeMs: MEDIA_KEPT_MS, now: Date.now() });

if (sweptMedia > 0) {
	log.info('old media removed', { count: sweptMedia });
}

const manager = new SessionManager({
	claudeBin: claudeBin ?? undefined,
	mediaDir,
	store,
	registryFile: paths.sessionsFile,
	home: paths.home,
	fetchOrientation: (ref) =>
		ref === SETUP_REF ? Promise.resolve(SETUP_ORIENTATION) : crew.fetchOrientation(ref),
});

store.onEffect(manager.handle);

// Audio plays in the tab the developer used last; the others show the line.
let speaker: string | null = null;
// Assigned once the gateway starts below; speech reaches the tabs through it.
let gateway: ReturnType<typeof startGateway> | null = null;

const tts = keys.soniox ? new SonioxTts({ apiKey: keys.soniox }) : null;
const voiceOut = new VoiceOut({
	store,
	synthesize: tts?.synthesize ?? null,
	play: (tab, message) => gateway?.send(tab, message) ?? false,
	speaker: () => speaker,
});
const narrate = createNarrator(keys.anthropic);

const narrateTurn = createTurnNarrator({
	store,
	narrate,
	writeTopic: createTopicWriter(keys.anthropic),
	say: (line) => voiceOut.say(line),
	journalDir: paths.journalDir,
	readGitHead,
});

const narrateAside = createAsideNarrator({ store, narrate, say: (line) => voiceOut.say(line) });

store.onEffect((effect) => {
	if (effect.type === 'speak') {
		voiceOut.say({
			text: effect.text,
			priority: effect.priority ?? (effect.source === 'alert' ? 'alert' : 'normal'),
			source: effect.source,
			isReply: effect.isReply,
			ref: effect.ref ?? null,
			isAsking: effect.isAsking,
			isNamed: effect.isNamed,
			isOwed: effect.isOwed,
			isAck: effect.isAck,
			isHoldable: effect.isHoldable,
			chime: effect.chime,
		});
	}

	if (effect.type === 'drop_speech') {
		voiceOut.dropQueuedAbout(effect.ref, effect.before);
	}

	if (effect.type === 'narrate') {
		return narrateTurn(effect);
	}

	if (effect.type === 'narrate_aside') {
		return narrateAside(effect);
	}

	if (effect.type === 'expire_command') {
		setTimeout(
			() => store.dispatch({ type: 'command_expired', askId: effect.askId }),
			COMMAND_TTL_MS,
		);
	}
});

const reminderTimer = setInterval(() => voiceOut.remind(store.state), REMINDER_INTERVAL_MS);

const devWatch = new DevWatch({ store, crew, say: (line) => voiceOut.say(line) });

store.onEffect((effect) => void devWatch.handle(effect));

const NOTES_ON_PAGE = 50;
const notesFiles = createNotesStore(paths.notesDir);

const notes: NotesStore = {
	...notesFiles,
	save: (words) => {
		notesFiles.save(words);

		const workspace = toNotesKey(words.workspace);
		log.info('note saved', { workspace, chars: words.text.length });
		store.dispatch({ type: 'notes', workspace, lines: notesFiles.read(workspace, NOTES_ON_PAGE) });
	},
};

const loadedNotes = Object.entries(notesFiles.readAll(NOTES_ON_PAGE));

for (const [workspace, lines] of loadedNotes) {
	store.dispatch({ type: 'notes', workspace, lines });
}

log.info('notes loaded', { workspaces: loadedNotes.length });

const kernel = keys.anthropic
	? new Kernel({
			apiKey: keys.anthropic,
			tools: {
				getState: () => store.state,
				dispatch: (action) => store.dispatch(action),
				readHistory: (query) => readHistory(paths.journalDir, query),
				mute: () => voiceOut.mute(),
				notes,
				saveDebugNote: ({ text, said }) => {
					const note = createDebugNote({ state: store.state, text, said, now: Date.now() });

					log.warn('debug note', { text, said, view: note.view });

					try {
						saveDebugNote(paths.debugNotesFile, note);
					} catch (error) {
						log.error('debug note not saved', { error: String(error) });
					}
				},
			},
		})
	: null;

// "Open the doc" opens in the tab that asked: the developer may be on a phone, far from this Mac.
const openUrlFor =
	(client: string): OpenUrl =>
	(url, title) => {
		const isSent = gateway?.send(client, { type: 'open_url', url, title }) ?? false;

		log.info(isSent ? 'doc sent to open' : 'doc not opened: tab gone', { client, title });

		return isSent;
	};

const handsFreeSwitchFor = createHandsFreeSwitch({
	// voiceIn is assigned below; a switch only runs once an utterance arrived through it.
	isListening: (client) => voiceIn.isListening(client),
	unlisten: (client) => voiceIn.unlisten(client),
	send: (client, message) => gateway?.send(client, message) ?? false,
	say: (text) => voiceOut.say({ text, priority: 'high', source: 'kernel', isReply: true }),
});

const router = new UtteranceRouter({
	store,
	kernel: kernel
		? async (text, options) => {
				const turn = await kernel.handle(text, options);

				if (turn.reply) {
					voiceOut.say({ text: turn.reply, priority: 'high', source: 'kernel', isReply: true });
				}

				return turn;
			}
		: null,
});
const voiceIn = new VoiceInput({
	store,
	apiKey: keys.soniox,
	onUtterance: (text, client, startedAt) =>
		void router.handle(text, 'voice', {
			setHandsFree: handsFreeSwitchFor(client),
			openUrl: openUrlFor(client),
			heardFrom: startedAt,
		}),
	onTalkStart: () => voiceOut.talkStarted(),
	onTalkEnd: () => voiceOut.talkEnded(),
	onListenOff: (client, reason) => void gateway?.send(client, { type: 'listen_off', reason }),
	listSpokenLines: () => voiceOut.listRecentSpeech(),
	debugAudioDir: process.env.VOICEOS_DEBUG_AUDIO === '1' ? paths.debugAudioDir : null,
});

const refreshWorktrees = async (): Promise<void> => {
	try {
		store.dispatch({
			type: 'worktrees',
			worktrees: [createSetupWorktree(paths.home), ...(await crew.listWorktrees())],
		});
	} catch (error) {
		log.warn('worktree refresh failed', { error: String(error) });

		if (store.state.order.length === 0) {
			store.dispatch({ type: 'worktrees', worktrees: [createSetupWorktree(paths.home)] });
		}
	}
};

await refreshWorktrees();
void devWatch.monitor();

persistTopics({ store, file: paths.topicsFile });

const pollTimer = setInterval(async () => {
	await refreshWorktrees();
	await devWatch.monitor();
}, WORKTREE_POLL_MS);

const proxyPort = Number(process.env.VOICEOS_PROXY_PORT) || null;
const proxyHttpsPort = Number(process.env.VOICEOS_PROXY_HTTPS_PORT) || null;

gateway = startGateway({
	store,
	token,
	port: Number(process.env.PORT) || 0,
	index,
	readMedia: (name) => readMediaFile({ name, dir: mediaDir }),
	listAllowedOrigins: (port) =>
		listAllowedOrigins({
			port,
			proxyHost: process.env.VOICEOS_PROXY_HOST ?? null,
			proxyPort,
			proxyHttpsPort,
		}),
	onMessage: (message, client) => {
		speaker = client;

		switch (message.type) {
			case 'action':
				store.dispatch(message.action);

				return;
			case 'utterance':
				void router.handle(message.text, 'typed', {
					setHandsFree: handsFreeSwitchFor(client),
					openUrl: openUrlFor(client),
				});

				return;
			case 'ptt_start':
				voiceIn.start(client, message.sampleRate);

				return;
			case 'ptt_stop':
				voiceIn.stop(client);

				return;
			case 'simulate_speech':
				if (!isSpeechSimulated) {
					log.warn('simulated speech refused: VOICEOS_DEBUG_SPEECH is not set');

					return;
				}

				voiceIn.simulate(client, message.text, message.holdMs);

				return;
			// The listening tab also plays speech, so its echo canceller knows what to remove.
			case 'listen_start':
				voiceIn.listen(client, message.sampleRate);

				return;
			case 'listen_stop':
				voiceIn.unlisten(client);

				return;
			case 'audio_done':
				voiceOut.clipDone(message.id);

				return;
		}
	},
	onAudio: (chunk, client) => voiceIn.pushAudio(client, chunk),
	onDisconnect: (client) => {
		voiceIn.disconnect(client);

		if (speaker === client) {
			speaker = null;
		}
	},
	readHealth: () => ({
		pid: process.pid,
		seq: store.state.seq,
		sessions: manager.listRunning().length,
	}),
});

const port = gateway.port;

if (shouldRecordState(process.env)) {
	writeFileSync(
		paths.stateFile,
		JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
	);
} else {
	log.warn('not launched by crew: state not recorded, so crew keeps its own port and pid', {
		port,
	});
}

log.info('voice os ready', { port, url: `http://localhost:${port}/login?token=…` });

void restoreHistory({
	store,
	sessions: loadRegistry(paths.sessionsFile),
	getCwd: (ref) => store.state.sessions[ref]?.cwd ?? null,
	getImageSource: (ref) => store.state.sessions[ref],
	mediaDir,
	loadMessages: loadTranscript,
});

const shutdown = (signal: string): void => {
	log.info('shutting down', { signal });
	clearInterval(pollTimer);
	clearInterval(reminderTimer);
	manager.stopAll();
	tts?.close();
	gateway?.stop();
	process.exit(0);
};

// crew voice stop kills the tmux session, which delivers SIGHUP.
process.on('SIGHUP', () => shutdown('SIGHUP'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

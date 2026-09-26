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
import { Kernel } from './router/kernel.js';
import { SETUP_ORIENTATION, SETUP_REF, createSetupWorktree } from './sessions/setup-session.js';
import { readHistory } from './memory/journal.js';
import { createDebugNote, saveDebugNote } from './memory/debug-notes.js';
import { createTurnNarrator, readGitHead } from './narrator/turn.js';
import { persistTopics } from './memory/topics.js';
import { resolveClaudeBin, isCompiled } from './sessions/claude-bin.js';
import { SessionManager } from './sessions/manager.js';
import { loadTranscript, restoreHistory } from './sessions/history.js';
import { loadRegistry } from './sessions/registry.js';
import { Store } from './state/store.js';
import { VoiceInput } from './speech/voice-in.js';
import { VoiceOut } from './speech/voice-out.js';
import { DevWatch } from './dev/watch.js';
import { SonioxTts } from './speech/tts.js';
import { createNarrator } from './narrator/narrator.js';

const WORKTREE_POLL_MS = 10_000;
const REMINDER_INTERVAL_MS = 30_000;

const paths = resolvePaths();

configureLog({ file: paths.logFile });

const log = createLogger('main');

const token = ensureToken(paths);
const keys = loadKeys(paths);
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

const crew = new CrewAdapter();
const manager = new SessionManager({
	claudeBin: claudeBin ?? undefined,
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
	say: (line) => voiceOut.say(line),
	journalDir: paths.journalDir,
	readGitHead,
});

store.onEffect((effect) => {
	if (effect.type === 'speak') {
		voiceOut.say({
			text: effect.text,
			priority: effect.source === 'alert' ? 'alert' : 'normal',
			source: effect.source,
			isReply: effect.isReply,
			ref: effect.ref ?? null,
			isAsking: effect.isAsking,
		});
	}

	if (effect.type === 'narrate') {
		return narrateTurn(effect);
	}
});

const reminderTimer = setInterval(() => voiceOut.remind(store.state), REMINDER_INTERVAL_MS);

const devWatch = new DevWatch({ store, crew, say: (line) => voiceOut.say(line) });

store.onEffect((effect) => void devWatch.handle(effect));

const kernel = keys.anthropic
	? new Kernel({
			apiKey: keys.anthropic,
			tools: {
				getState: () => store.state,
				dispatch: (action) => store.dispatch(action),
				readHistory: (query) => readHistory(paths.journalDir, query),
				mute: () => voiceOut.mute(),
				saveDebugNote: (text) => {
					const note = createDebugNote(store.state, text, Date.now());

					log.warn('debug note', { text, view: note.view });

					try {
						saveDebugNote(paths.debugNotesFile, note);
					} catch (error) {
						log.error('debug note not saved', { error: String(error) });
					}
				},
			},
		})
	: null;

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
	onUtterance: (text) => void router.handle(text),
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
				void router.handle(message.text, 'typed');

				return;
			case 'ptt_start':
				voiceIn.start(client, message.sampleRate);

				return;
			case 'ptt_stop':
				voiceIn.stop(client);

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

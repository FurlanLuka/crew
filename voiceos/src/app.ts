import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readMediaFile, sweepMedia } from './sessions/media.js';
import { ATTACHMENTS_KEPT_MS, storeAttachment, sweepAttachments } from './sessions/attachments.js';
import type { OpenUrl } from './tools/docs.js';
import index from './web/index.html';
import { ensureToken, missingFor, resolvePaths, shouldRecordState, type Keys } from './config.js';
import { type KeyedServices, buildKeyedServices, holdKeyedServices } from './keyed-services.js';
import type { Judge } from './judge/judge.js';
import { CrewAdapter, spawnRunner, startDetached } from './crew/adapter.js';
import { createSetupRunner } from './crew/api.js';
import { listAllowedOrigins } from './gateway/auth.js';
import { startGateway } from './gateway/server.js';
import { attachFileTo } from './gateway/attach.js';
import { configureLog, createLogger } from './log.js';
import { UtteranceRouter } from './router/router.js';
import { Kernel } from './router/kernel.js';
import {
	LEGACY_SETUP_REF,
	SETUP_ORIENTATION,
	SETUP_REF,
	createSetupWorktree,
} from './sessions/setup-session.js';
import { readHistory } from './memory/journal.js';
import { createRecapWriter } from './recap/writer.js';
import { createDebugNote, saveDebugNote } from './memory/debug-notes.js';
import { createNotesStore, type NotesStore } from './memory/notes.js';
import { toNotesKey } from './shared/notes.js';
import { createAsideNarrator, createTurnNarrator, readGitHead } from './narrator/turn.js';
import { persistView, shouldAnnounceRestart } from './memory/view.js';
import { persistActive } from './memory/active.js';
import { persistNames } from './memory/names.js';
import { persistVoiceOff } from './memory/voice-off.js';
import { followVoiceOff } from './speech/voice-off.js';
import { resolveClaudeBin, isCompiled } from './sessions/claude-bin.js';
import { SessionManager, connectStore } from './sessions/manager.js';
import { loadTranscript, restoreHistory } from './sessions/history.js';
import { loadRegistry, renameSession } from './sessions/registry.js';
import { Store } from './state/store.js';
import { createListenSwitch } from './speech/hands-free-switch.js';
import { VoiceInput } from './speech/voice-in.js';
import { VoiceOut } from './speech/voice-out.js';
import { applyPageAction } from './router/page-actions.js';
import { connectSpeech, speakKernelReplies } from './speech/connect.js';
import { DevWatch } from './dev/watch.js';
import { connectMachines, readMachineStatuses } from './remote/cockpit-machines.js';
import { DISCORD_CLIENT } from './discord/bridge.js';
import { DISCORD_SAMPLE_RATE } from './discord/audio.js';
import { startDiscordVoice } from './discord/discord.js';
import { SpeakerSeat, decidePageMic } from './discord/seat.js';
import type { ServerMessage } from './shared/protocol.js';

const WORKTREE_POLL_MS = 10_000;
const REMINDER_INTERVAL_MS = 30_000;

const paths = resolvePaths();

configureLog({ file: paths.logFile });

const log = createLogger('main');

const token = ensureToken(paths);
// Lets a page inject heard words (window.voiceos.say) — demos and screenshots, never by default.
const isSpeechSimulated = process.env.VOICEOS_DEBUG_SPEECH === '1';
const store = new Store();

const claudeBin = resolveClaudeBin({
	override: process.env.VOICEOS_CLAUDE_BIN,
	compiled: isCompiled(),
	which: (command) => Bun.which(command),
});

// What the page's "before you talk" sheet lists: the keys, again whenever they change, and claude.
const reportMissing = (keys: Keys): void => {
	store.dispatch({ type: 'setup', missing: missingFor({ keys, paths, claudeBin }) });
};

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

// Files the developer attached, by content; a session's Claude reads them at their path.
const attachmentsDir = join(paths.voiceDir, 'attachments');
const sweptAttachments = sweepAttachments({
	dir: attachmentsDir,
	maxAgeMs: ATTACHMENTS_KEPT_MS,
	now: Date.now(),
});

if (sweptAttachments > 0) {
	log.info('old attachments removed', { count: sweptAttachments });
}

const manager = new SessionManager({
	claudeBin: claudeBin ?? undefined,
	mediaDir,
	attachmentsDir,
	...connectStore(store),
	registryFile: paths.sessionsFile,
	home: paths.home,
	fetchOrientation: (ref) =>
		ref === SETUP_REF ? Promise.resolve(SETUP_ORIENTATION) : crew.fetchOrientation(ref),
});

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

const createKernel = (apiKey: string, keyedJudge: Judge): Kernel =>
	new Kernel({
		apiKey,
		tools: {
			getState: () => store.state,
			dispatch: (action) => store.dispatch(action),
			readHistory: (query) => readHistory(paths.journalDir, query),
			// Defined below, with the machines' links; a turn only runs once they exist.
			runCrewOn: (machine, command) => runSetupCommand(machine, command),
			// Built with the kernel, so a new Anthropic key reaches it too.
			writeRecap: createRecapWriter({ apiKey }),
			mute: () => voiceOut.mute(),
			notes,
			judge: keyedJudge,
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
	});

// A key saved while Voice OS runs (the page's keys sheet, crew server keys set) is used from the next
// utterance on: the services are rebuilt and the page's missing list follows.
const services = holdKeyedServices<KeyedServices<Kernel>>({
	paths,
	build: (keys, previous) => buildKeyedServices({ keys, createKernel, previous }),
	onChange: (next, previous) => {
		// Only a replaced voice is closed: one whose key did not change is still the one speaking.
		if (previous.tts !== next.tts) {
			previous.tts?.close();
		}

		reportMissing(next.keys);
	},
});

reportMissing(services.current.keys);

// Audio plays in the tab the developer used last, or in the voice channel; the others show the line.
const seat = new SpeakerSeat();
// Assigned once the gateway starts below; speech reaches the tabs through it.
let gateway: ReturnType<typeof startGateway> | null = null;

// The voice channel is one more client: what is sent to it goes to Discord, everything else to a page.
// discord is assigned below, before anything is said or heard.
const sendToClient = (client: string, message: ServerMessage): boolean =>
	client === DISCORD_CLIENT ? discord.send(message) : (gateway?.send(client, message) ?? false);

const voiceOut: VoiceOut = new VoiceOut({
	store,
	get synthesize() {
		return services.current.tts?.synthesize ?? null;
	},
	play: sendToClient,
	speaker: () => seat.current,
	hasPage: () => (gateway?.countClients() ?? 0) > 0 || discord.isOwnerIn(),
	// voiceIn is assigned below; it is only asked once speech is under way.
	isListening: () => voiceIn.isListening(),
	// Words Voice OS's follow-ups; without the Anthropic key, the fixed lines.
	writeFollowUp: (input) => services.current.voiceLines.followUp(input),
});
// One judge for the kernel's guards and the router's "For X?", whichever key is current.
const judge: Judge = (params) => services.current.judge(params);

const narrateTurn = createTurnNarrator({
	store,
	narrate: (input) => services.current.narrate(input),
	writeAbout: (input) => services.current.writeAbout(input),
	say: (line) => voiceOut.say(line),
	journalDir: paths.journalDir,
	readGitHead,
});

const narrateAside = createAsideNarrator({
	store,
	narrate: (input) => services.current.narrate(input),
	say: (line) => voiceOut.say(line),
});

connectSpeech({ store, voiceOut, narrateTurn, narrateAside, isRouting: () => router.isRouting });

const reminderTimer = setInterval(() => voiceOut.remind(store.state), REMINDER_INTERVAL_MS);

const machines = connectMachines({
	store,
	voiceDir: paths.voiceDir,
	home: paths.home,
	mediaDir,
	attachmentsDir,
	crew,
	runCrew: spawnRunner,
	manager,
	say: (text) => voiceOut.say({ text, priority: 'high', source: 'kernel' }),
	sayLine: (line) => voiceOut.say(line),
	onStatusesChanged: () => recordState(),
});

// "Open the doc" opens in the tab that asked: the developer may be on a phone, far from this Mac.
const openUrlFor =
	(client: string): OpenUrl =>
	(url, title) => {
		const isSent = sendToClient(client, { type: 'open_url', url, title });

		log.info(isSent ? 'doc sent to open' : 'doc not opened: tab gone', { client, title });

		return isSent;
	};

const listenSwitchFor = createListenSwitch({
	// voiceIn is assigned below; a switch only runs once an utterance arrived through it.
	modeOf: (client) => voiceIn.listenModeOf(client),
	unlisten: (client) => voiceIn.unlisten(client),
	send: sendToClient,
	say: (text) => voiceOut.say({ text, priority: 'high', source: 'kernel', isReply: true }),
});

const router = new UtteranceRouter({
	store,
	judge,
	get kernel() {
		const { kernel } = services.current;

		return kernel
			? speakKernelReplies((text, options) => kernel.handle(text, options), voiceOut)
			: null;
	},
	onKernelTurn: (turn) => voiceOut.kernelTurnStarted(turn),
});
const voiceIn: VoiceInput = new VoiceInput({
	store,
	get apiKey() {
		return services.current.keys.soniox;
	},
	onUtterance: (text, client, startedAt, { isDictated }) =>
		void router.handle(text, isDictated ? 'dictated' : 'voice', {
			setListenMode: listenSwitchFor(client),
			openUrl: openUrlFor(client),
			heardFrom: startedAt,
			keepDictation: (kept, reason) =>
				void sendToClient(client, { type: 'dictation_kept', text: kept, reason }),
		}),
	onTalkStart: () => voiceOut.talkStarted(),
	onTalkEnd: () => voiceOut.talkEnded(),
	onListenOff: (client, reason) => void sendToClient(client, { type: 'listen_off', reason }),
	onListenState: (client, isAwake) => void sendToClient(client, { type: 'listen_state', isAwake }),
	onHeardIgnored: (client) => void sendToClient(client, { type: 'heard_ignored' }),
	onKept: (text, client, reason) =>
		void sendToClient(client, { type: 'dictation_kept', text, reason }),
	listSpokenLines: () => voiceOut.listRecentSpeech(),
	debugAudioDir: process.env.VOICEOS_DEBUG_AUDIO === '1' ? paths.debugAudioDir : null,
});

// Before Discord starts: with voice off its bot never joins the channel only to leave it.
persistVoiceOff({ store, file: paths.voiceOffFile });

const discord = startDiscordVoice({
	store,
	voiceDir: paths.voiceDir,
	keysDir: paths.keysDir,
	startPaused: store.state.voiceOff,
	onOwnerIn: (mode) => {
		if (store.state.voiceOff) {
			return;
		}

		voiceIn.listen(DISCORD_CLIENT, DISCORD_SAMPLE_RATE, mode);

		// Called again on a mode change: the channel already has the seat, nothing to announce.
		if (!seat.discordJoined()) {
			return;
		}

		voiceOut.say({
			text: "You're on Discord now: Voice OS listens here.",
			priority: 'high',
			source: 'kernel',
		});
	},
	onOwnerOut: () => {
		voiceIn.disconnect(DISCORD_CLIENT);
		seat.discordLeft();
	},
	onAudio: (mono) => voiceIn.pushAudio(DISCORD_CLIENT, mono),
	onClipDone: (id) => voiceOut.clipDone(id),
});

// Voice off lets go of everything that talks to Soniox or Discord's voice; the page lets go of its mic.
followVoiceOff({
	store,
	onOff: () => {
		voiceIn.disconnectAll('voice off');
		voiceOut.voiceTurnedOff();
		services.current.tts?.close();
		discord.pause();
	},
	// Each page announces its own listening again; Discord's owner is heard once the bot is back.
	onOn: () => discord.resume(),
});

const bootAt = Date.now();
const startedAt = new Date(bootAt).toISOString();
// Pages reconnect by themselves after a restart: the first one hears why the page blinked.
let isRestartSaid = false;

// crew reads the port and pid from here, and `crew server machines ls` each machine's status.
function recordState(): void {
	if (!shouldRecordState(process.env) || !gateway) {
		return;
	}

	try {
		writeFileSync(
			paths.stateFile,
			JSON.stringify(
				{
					port: gateway.port,
					pid: process.pid,
					startedAt,
					machines: readMachineStatuses(store.state),
				},
				null,
				2,
			),
		);
	} catch (error) {
		log.warn('state not recorded', { error: String(error) });
	}
}

await machines.refreshWorktrees();
void machines.monitorDevServers();

// Before the view: a saved session view opened from Active finds its session already active. Starts
// the active sessions of this Mac; a remote's start when its link is up.
persistActive({ store, file: paths.activeFile, legacyFile: paths.pinnedFile });
persistNames({ store, file: paths.namesFile });
const hadSavedView = persistView({ store, file: paths.viewFile });

const pollTimer = setInterval(async () => {
	machines.loadMachines();
	await machines.refreshWorktrees();
	await machines.monitorDevServers();
}, WORKTREE_POLL_MS);

const proxyPort = Number(process.env.VOICEOS_PROXY_PORT) || null;
const proxyHttpsPort = Number(process.env.VOICEOS_PROXY_HTTPS_PORT) || null;

// Set up's door to crew on any machine; plain sessions are made and removed through it by voice too.
const runSetupCommand = createSetupRunner({
	runLocal: spawnRunner,
	startLocal: startDetached,
	getLink: machines.getLink,
});

gateway = startGateway({
	store,
	token,
	port: Number(process.env.PORT) || 0,
	index,
	readMedia: (name) => readMediaFile({ name, dir: mediaDir }),
	runCrew: runSetupCommand,
	attachFile: attachFileTo({
		readState: () => store.state,
		dispatch: (observation) => store.dispatch(observation),
		store: (params) => storeAttachment({ ...params, dir: attachmentsDir, mediaDir }),
	}),
	listAllowedOrigins: (port) =>
		listAllowedOrigins({
			port,
			proxyHost: process.env.VOICEOS_PROXY_HOST ?? null,
			proxyPort,
			proxyHttpsPort,
		}),
	onMessage: (message, client) => {
		seat.pageUsed(client);

		switch (message.type) {
			case 'action':
				// Several pages can be open; the view is shared, so a switch names the page that made it.
				if (message.action.type === 'switch_view') {
					log.info('view switched', { client, view: message.action.view });
				}

				applyPageAction(store, message.action);

				return;
			case 'utterance':
				void router.handle(message.text, 'typed', {
					setListenMode: listenSwitchFor(client),
					openUrl: openUrlFor(client),
				});

				return;
			case 'ptt_start':
				if (decidePageMic('ptt_start', seat.isOnDiscord, store.state.voiceOff) !== 'allow') {
					log.info('page mic ignored', {
						client,
						why: store.state.voiceOff ? 'voice off' : 'voice is on Discord',
					});

					return;
				}

				voiceIn.start(client, message.sampleRate, { isDictation: message.dictation === true });

				return;
			case 'ptt_stop':
				voiceIn.stop(client);

				return;
			case 'ptt_cancel':
				voiceIn.cancel(client);

				return;
			case 'simulate_speech':
				if (!isSpeechSimulated) {
					log.warn('simulated speech refused: VOICEOS_DEBUG_SPEECH is not set');

					return;
				}

				voiceIn.simulate(client, message.text, message.holdMs);

				return;
			// The listening tab also plays speech, so its echo canceller knows what to remove.
			case 'listen_start': {
				const listenVerdict = decidePageMic('listen_start', seat.isOnDiscord, store.state.voiceOff);

				if (listenVerdict === 'refuse') {
					log.info('page mic refused: voice is on Discord', { client });
					sendToClient(client, { type: 'listen_off', reason: 'voice is on Discord' });

					return;
				}

				if (listenVerdict === 'ignore') {
					log.info('page listening ignored: voice off', { client });

					return;
				}

				voiceIn.listen(client, message.sampleRate, message.mode ?? 'hands-free');

				return;
			}
			case 'listen_stop':
				voiceIn.unlisten(client);

				return;
			case 'audio_done':
				voiceOut.clipDone(message.id);

				return;
			case 'discord_listen':
				discord.setMode(message.mode);

				return;
		}
	},
	onAudio: (chunk, client) => voiceIn.pushAudio(client, chunk),
	onConnect: (client) => {
		seat.pageOpened(client);

		if (!shouldAnnounceRestart({ bootAt, now: Date.now(), isSaid: isRestartSaid, hadSavedView })) {
			return;
		}

		isRestartSaid = true;
		voiceOut.say({ text: 'Voice OS restarted.', priority: 'high', source: 'kernel' });
	},
	onDisconnect: (client) => {
		voiceIn.disconnect(client);
		seat.pageClosed(client);
	},
	readHealth: () => ({
		pid: process.pid,
		seq: store.state.seq,
		sessions: manager.listRunning().length,
	}),
});

const port = gateway.port;

if (shouldRecordState(process.env)) {
	recordState();
} else {
	log.warn('not launched by crew: state not recorded, so crew keeps its own port and pid', {
		port,
	});
}

log.info('voice os ready', { port, url: `http://localhost:${port}/login?token=…` });

void restoreHistory({
	dispatch: (observation) => store.dispatch(observation),
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
	machines.stop();
	discord.stop();
	services.stop();
	services.current.tts?.close();
	gateway?.stop();
	process.exit(0);
};

// crew server stop kills the tmux session, which delivers SIGHUP.
process.on('SIGHUP', () => shutdown('SIGHUP'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

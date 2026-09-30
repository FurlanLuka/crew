// A whole voice conversation in a test: the real store, kernel (scripted model), router, narrator
// and voice, wired as the app wires them. What the developer hears is the list of clips that played
// to the end, in order, with their own words marked in between.
import { englishJudge } from './english-judge.js';
import type { Judge } from '../../src/judge/judge.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { Kernel } from '../../src/router/kernel.js';
import { UtteranceRouter } from '../../src/router/router.js';
import { createAsideNarrator, createTurnNarrator } from '../../src/narrator/turn.js';
import type { Input, WorktreeInfo } from '../../src/shared/protocol.js';
import { connectSpeech, speakKernelReplies } from '../../src/speech/connect.js';
import { VoiceOut } from '../../src/speech/voice-out.js';
import { Store } from '../../src/state/store.js';
import { createNullNotes } from './notes.js';

type Block = Anthropic.ContentBlock;

export const toolUse = (id: string, name: string, input: Record<string, unknown>): Block =>
	({ type: 'tool_use', id, name, input }) as unknown as Block;

export const reply = (text: string): Block => ({ type: 'text', text }) as unknown as Block;

const worktree = (ref: string): WorktreeInfo => ({
	ref,
	label: ref,
	branch: '',
	cwd: `/w/${ref}`,
	dirs: [],
	isPinned: false,
});

const flush = async (): Promise<void> => {
	for (let index = 0; index < 20; index++) {
		await Promise.resolve();
	}
};

interface CreateConversationParams {
	refs: string[];
	// The session on screen; null is Mission Control.
	view: string | null;
	// A tab listens all the time (on demand, hands-free).
	isListening?: boolean;
	// The English patterns unless a conversation needs the judge to hear something else.
	judge?: Judge;
}

export const createConversation = ({
	refs,
	view,
	isListening = false,
	judge = englishJudge,
}: CreateConversationParams) => {
	let now = 1_000_000;
	const clock = () => now;
	const store = new Store(clock);
	const inputs: Input[] = [];
	store.subscribe((stamped) => inputs.push(stamped.input));
	store.dispatch({ type: 'worktrees', worktrees: refs.map(worktree) });

	if (view) {
		store.dispatch({ type: 'switch_view', view: { kind: 'session', ref: view } });
	}

	// The model's answers, one list of blocks per call, in the order the calls come.
	const script: Block[][] = [];
	// What the model was sent on each call: routing is its decision, so a test asserts what it was told.
	const requests: { messages: { role: string; content: unknown }[] }[] = [];
	const client = {
		messages: {
			create: async (params: { messages: { role: string; content: unknown }[] }) => {
				requests.push(params);
				const content = script.shift() ?? [reply('')];
				const hasToolUse = content.some((block) => block.type === 'tool_use');

				return { content, stop_reason: hasToolUse ? 'tool_use' : 'end_turn' };
			},
		},
	} as unknown as Anthropic;

	// What the developer heard: each clip played to its end, and their own words as "> …".
	const heard: string[] = [];
	const clips = new Map<string, string>();
	const cut = new Set<string>();
	let playingId: string | null = null;
	const timers: { at: number; run: () => void }[] = [];

	const setTimer = (run: () => void, ms: number): void => {
		timers.push({ at: now + ms, run });
	};

	const voiceOut = new VoiceOut({
		store,
		synthesize: async ({ id, text, onAudio }) => {
			clips.set(id, text);
			playingId = id;
			onAudio(new Uint8Array(480));
		},
		play: (_tab, message) => {
			if (message.type === 'audio_cancel') {
				cut.add(message.id);
			}

			return true;
		},
		speaker: () => 'tab',
		hasPage: () => true,
		now: clock,
		setTimer,
		isListening: () => isListening,
	});
	const narrate = async () => ({
		speak: false,
		needs_user: false,
		priority: 'normal' as const,
		text: '',
		topic: null,
	});
	connectSpeech({
		store,
		voiceOut,
		narrateTurn: createTurnNarrator({
			store,
			narrate,
			writeTopic: async () => ({ topic: null, about: null }),
			say: (line) => voiceOut.say(line),
			journalDir: mkdtempSync(join(tmpdir(), 'voiceos-journal-')),
			readGitHead: async () => null,
			clock,
		}),
		narrateAside: createAsideNarrator({ store, narrate, say: (line) => voiceOut.say(line) }),
		setTimer,
	});
	const kernel = new Kernel({
		apiKey: 'k',
		client,
		now: clock,
		tools: {
			getState: () => store.state,
			dispatch: (action) => store.dispatch(action),
			readHistory: () => [],
			mute: () => voiceOut.mute(),
			saveDebugNote: () => undefined,
			judge,
			notes: createNullNotes(),
		},
	});
	const router = new UtteranceRouter({
		store,
		judge,
		kernel: speakKernelReplies((text, options) => kernel.handle(text, options), voiceOut),
		now: clock,
	});

	// Plays what is queued, clip by clip, to the end: the developer listens without interrupting.
	const listen = async (): Promise<void> => {
		for (let guard = 0; guard < 50; guard++) {
			await flush();

			if (!playingId) {
				return;
			}

			const id = playingId;
			playingId = null;

			if (!cut.has(id)) {
				heard.push(clips.get(id) ?? '');
			}

			voiceOut.clipDone(id);
		}
	};

	// Moves the clock, running what came due on the way (lapses, the quiet before "meanwhile").
	const wait = async (ms: number): Promise<void> => {
		const until = now + ms;

		for (;;) {
			timers.sort((first, second) => first.at - second.at);
			const next = timers[0];

			if (!next || next.at > until) {
				break;
			}

			timers.shift();
			now = next.at;
			next.run();
			await listen();
		}

		now = until;
		await listen();
	};

	// The first message of the kernel's last turn: the state and the words, as the model read them.
	const kernelSaw = (): string => {
		const first = requests.findLast((request) => request.messages.length === 1)?.messages[0];
		const content = first?.content;

		return typeof content === 'string'
			? content
			: Array.isArray(content)
				? content.map((block: { text?: string }) => block.text ?? '').join('\n')
				: '';
	};

	return {
		store,
		inputs,
		heard,
		kernelSaw,
		voiceOut,
		wait,
		listen,
		startSessions: async (...started: string[]) => {
			for (const ref of started) {
				store.dispatch({ type: 'start_session', ref });
				store.dispatch({ type: 'session_started', ref } as Input);
			}

			await listen();
		},
		show: async (ref: string | null) => {
			store.dispatch({
				type: 'switch_view',
				view: ref ? { kind: 'session', ref } : { kind: 'grid' },
			});
			await listen();
		},
		// The kernel's model calls for the next utterance, in order.
		script: (...calls: Block[][]) => {
			script.push(...calls);
		},
		// The developer speaks (push to talk): what plays is cut, and nothing plays until they finish.
		say: async (text: string) => {
			// Speaking takes a moment: turns said one after another are never at the same instant.
			now += 1000;
			voiceOut.talkStarted();
			heard.push(`> ${text}`);
			voiceOut.talkEnded();
			await router.handle(text, 'voice', { heardFrom: now });
			await listen();
		},
		// The developer types into the box (a session page routes it straight to that session).
		type: async (text: string) => {
			now += 1000;
			await router.handle(text, 'typed', { heardFrom: now });
			await listen();
		},
		// A session ends its turn with its own spoken line.
		answer: async (ref: string, line: string) => {
			store.dispatch({ type: 'turn_ended', ref, costUsd: 0, text: `<spoken>${line}</spoken>` });
			await listen();
		},
	};
};

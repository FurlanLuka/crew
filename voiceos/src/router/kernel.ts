import Anthropic from '@anthropic-ai/sdk';
import {
	GRID,
	isOfferFresh,
	isRemembered,
	type SpokenLine,
	type State,
	type VoiceEntry,
} from '../shared/protocol.js';
import { formatAge } from '../state/working.js';
import { createLogger } from '../log.js';
import { executeTool, type ToolContext } from '../tools/tools.js';
import { isSilentCall, describeToolCall } from '../tools/call-lines.js';
import { listToolsFor, type ToolCall } from '../tools/definitions.js';
import { describeSession } from '../tools/session-view.js';

const log = createLogger('kernel');
export const KERNEL_MODEL = 'claude-haiku-4-5';
const MAX_STEPS = 4;

export const KERNEL_SYSTEM = `You are the voice kernel of Voice OS: a developer runs several Claude Code sessions, one per git worktree, and talks to you instead of clicking. Everything they say reaches you, and you decide what happens: pass it to a session, answer what a session is waiting on, act on Voice OS itself, or say nothing.

When the screen shows one session (see "Screen:"):
- Speech meant for that session goes to it: instructions, questions about the code, its logs or the work, replies to what it said, thinking out loud about the task. Do not answer it yourself: call forward with it written as a clear instruction or question to that Claude, in the developer's voice. Drop relay words ("can you ask it to", "tell it to") and false starts; keep every detail, name, number, negation and reaction; add nothing they did not say. "can you ask it to check the logs" is forward "Check the logs." "hmm, I don't like that, revert it" is forward "I don't like that — revert it." "why is this so slow", "run the tests", "yes but use the table" are for the session.
- The pinned voiceos session is a session like any other: when it is on screen, forward speech to it.
- When unsure whether speech is for the session on screen, forward it: the session can ask back. Do not ask the developer which session they mean while one is on screen, unless they named two. Never forward a command for Voice OS: opening, switching or going back, starting, stopping or interrupting sessions, quiet, and questions about which sessions are waiting, running or doing what — those are yours, even when they begin "Voice OS, …".
- Words that happen to match another session's topic do not make it about that session: the developer is talking to the session in front of them. Only an explicit reference switches the target — "tell checkout…", "in the ranking one…", "checkout, run the tests", "open…".
- An instruction that names another session goes to it: "have checkout run the migrations" while store front is on screen is send_to the checkout session.
- Instructions about how the session should work or talk to the developer — "ask me with the question tool…", "use a table", "reply in one line" — are for that session: forward them.

Answering what a session waits on (see "pending", "asked" and "Voice OS last asked aloud"):
- "pending" is an open permission, plan or question: answer it with the answer tool, never by forward. Only a clear yes, no, always or choice answers it — "hmm" is thinking, and other words for that session ("also run the linter") are no answer: say it is waiting on its permission or plan first. For a permission or plan, "yes", "okay", "sure", "go ahead", "do it" are yes; "always" is always; "no …" is no with the rest as text ("No, use a new branch" is no with "use a new branch"). "Yes, but only on staging" is answer yes with text "Only on staging." — the text reaches the session with the answer. For a question, choose the listed option the developer meant — "the second one" is the second label, "reuse it" is "Reuse orders" — or their own words when none fits; keep detail they add to an option ("New table, partitioned").
- "asked" is a question a session ended its turn on: the developer's reply is its answer. forward it (or send_to when that session is not on screen) as they said it; never ask them the question again, never read_state first.
- A bare reply ("yes", "no", "do it", "go ahead") answers whatever was just asked aloud (see "Voice OS last asked aloud"): a session's pending or asked question, or Voice OS's own fix offer ("…want Claude to fix it?" — dev_offer). That may not be the session on screen. When "Waiting on the developer" lists one thing, a bare reply answers it from any screen — do not ask which. When two or more wait, "Voice OS last asked aloud" says which; ask which only when nothing does. One bare reply answers one thing, never several.
- When nothing waits, a reply on a session's screen ("yes, but use the table", "no, the other file") is for that session: forward it.
- A yes meant for a fix offer is always dev_offer, however old: it says when the offer lapsed, and then you tell the developer. Never crew_dev in its place.
- "Options", "what are the options": a pending question lists its options — read them out, briefly and numbered. Otherwise read_state the session that asked and list the options it actually offered in its recent output — that list may be longer than one sentence. If it offered none, reply exactly "Nothing is waiting on a choice." and nothing more — what the developer asked a session for is not a question it asked back; never take options from your own earlier words or the developer's. Never forward it.
- "Allow it", "let it" after auto mode blocked something ("blocked") is allow_denied.

Voice OS itself:
- open, switch to, show, go to X → switch_view X. X may be what a session works on ("back to where we're doing the data analysis"): match it against each session's last_messages_to_it and topic. Home, go back, Mission Control, show me everything → switch_view with null.
- start X → start_session (it also opens X). end, close, stop session X → stop_session.
- stop, wait, hold on, cancel → interrupt the session on screen when it is working (status running or blocked). On Mission Control, with no session named, never interrupt: when a session is working, ask in a few words whether to stop it; otherwise it only meant Voice OS should stop talking — ignore_words.
- quiet, shut up, mute → mute.
- "debug note: …", "add a debug note …" → debug_note with their words after it, as said. It is for Voice OS's own debugging: never forward it to a session. Reply "Noted."
- What another session is doing — "what's the setup status?", "what's checkout doing?", "check on it", "is it done?": find the session by what it was asked (last_messages_to_it; the setup session is voiceos) or its topic, and answer from its status, working_for and those messages. For more detail call read_state on it — it shows its latest steps. Never send a busy session a question to find out: it would wait behind its work or disturb it.

Rules:
- Use tools; never describe an action instead of taking it. A request for several things gets all of them in one response: "restart the dev servers and have it check the logs" is crew_dev restart and forward "Check the logs." together.
- "Earlier on this screen" is done. Act only on what the developer says now, and never repeat an earlier action unless they ask for it again: after a restart, "also start the session" is start_session alone.
- Opening, switching to or showing a session only shows it: never call start_session unless the developer asked to start it. forward and send_to start a stopped session by themselves: words meant for a session always go through forward or send_to, never through start_session.
- Words that ask for nothing and want nothing done — a thought that stops before saying what it wants ("and can you", "let's, um", or a name ending in a dash like "store front main—": the developer was cut off), or only a greeting or acknowledgement ("okay", "hey", "thanks", "hmm") with nothing waiting on an answer — call ignore_words alone and write no text, not even "I'm listening". Filler or a false start in front of a request never makes it this: "Hmm, let's start this." is a request to start the session on screen (on Mission Control, where "this" names nothing, ask which session), and "And can you tell me what's running?" is a question to answer. A question always gets a spoken answer.
- Dev servers: a session lists its servers under dev_servers only when some are not running. "What's wrong with the dev servers" or "are they up" you answer yourself, from dev_servers and their detail, without crew_dev status and without forwarding — a question is answered, never passed on as work nobody asked for. Only when the developer asks for work — look into why, check the logs, fix them — does it go to that session's Claude: forward (or send_to) it there; sending starts a stopped session.
- Every session's status, topic, what it waits on and what it was last asked are already in the message: answer from them. Call read_state only when you need a session's recent output or steps, read_history for what it did before. Never guess.
- Refer to sessions by the ref the state lists. The developer may name a session by its topic ("the ranking work") — match it against topics. Worktree names are spoken as words: "work one" is wrk1, "store front" is store-front. Speech-to-text writes some spoken numbers as digits: "the checkout retry 1" is "the checkout retry one" (the one about retries), not wrk1 — a digit names a worktree only right after "work".
- When exactly one session matches a name or topic, act on it — never ask "did you mean X?" about the only match.
- Ask one short question, and change nothing — one sentence, never a list of sessions — only when two or more sessions really match (for example "main" when several workspaces have a main worktree), or when you cannot tell what to do. Never guess which session to stop, start or send to.
- On Mission Control (no session on screen), send_to only when the developer clearly asked for work or an answer in a session, written as a clear instruction as above. Never invent instructions.
- Setup work — creating or removing worktrees, registering projects, bindings, crew fix or verify — belongs to the pinned voiceos session: send_to it with the developer's request. It runs the crew CLI and asks for permission before anything destructive. start_session only starts existing worktrees.
- Reply for the ear in one short sentence — at most 15 words unless the developer asked for detail or a list — with the fact only: "Two sessions are waiting: checkout and ranking." not "I checked the state and found that two sessions are currently waiting on you." No code, no paths, no markdown. Navigation, forwarding, answering, interrupting and starting or stopping dev servers need no reply; every question gets a spoken answer, even when the answer is "nothing is waiting".`;

export type Screen = string | null;

const ASKED_ALOUD_MS = 2 * 60_000;

const recallVoiceEntries = (state: State, screen: Screen, now: number): VoiceEntry[] => {
	return (state.voiceLog[screen ?? GRID] ?? []).filter((entry) => isRemembered(entry, now));
};

const formatRememberedLines = (memory: VoiceEntry[]): string => {
	if (memory.length === 0) {
		return '(none)';
	}

	return memory
		.map((entry) =>
			[
				`developer: ${entry.utterance}`,
				...(entry.did.length ? [`you did: ${entry.did.join('; ')}`] : []),
				...(entry.reply ? [`you: ${entry.reply}`] : []),
			].join('\n'),
		)
		.join('\n');
};

interface WaitingItem {
	ref: string;
	what: 'pending' | 'asked' | 'fix_offer';
	at: number;
}

export const listWaitingItems = (state: State, now: number): WaitingItem[] => {
	return [
		...state.asks.map((ask): WaitingItem => ({ ref: ask.ref, what: 'pending', at: ask.at })),
		...state.order.flatMap((ref): WaitingItem[] => {
			const needsUser = state.sessions[ref]?.needsUser;

			return needsUser ? [{ ref, what: 'asked', at: needsUser.at }] : [];
		}),
		...(isOfferFresh(state.devOffer, now)
			? [{ ref: state.devOffer.ref, what: 'fix_offer' as const, at: state.devOffer.at }]
			: []),
	].sort((first, second) => second.at - first.at);
};

const findLastAskedAloud = (
	state: State,
	waiting: WaitingItem[],
	now: number,
): SpokenLine | null => {
	// The newest line about a session that still waits is what a bare "yes" most likely answers.
	return (
		state.spoken
			.filter(
				(line) =>
					line.isAsking &&
					line.ref &&
					now - line.at <= ASKED_ALOUD_MS &&
					waiting.some((item) => item.ref === line.ref),
			)
			.at(-1) ?? null
	);
};

const describeAskedAloud = (line: SpokenLine | null, now: number): string => {
	return line
		? `"${line.text}" (about ${line.ref}, ${Math.round((now - line.at) / 1000)}s ago)`
		: '(nothing)';
};

const formatWaitingLine = (
	waiting: WaitingItem[],
	now: number,
	askedAloudRef: string | null,
): string => {
	if (waiting.length === 0) {
		return 'nothing';
	}

	// Counted, so a lone "yes" is never met with "which one?" when only one thing waits.
	return `${waiting.length}, newest first: ${waiting.map((item) => `${item.ref} (${item.what}, ${formatAge(now - item.at)} ago${item.ref === askedAloudRef ? ', just asked aloud' : ''})`).join('; ')}`;
};

interface BuildKernelMessageParams {
	state: State;
	utterance: string;
	memory: VoiceEntry[];
	now: number;
}

export const buildKernelMessage = ({
	state,
	utterance,
	memory,
	now,
}: BuildKernelMessageParams): string => {
	const sessionOnScreen =
		state.view.kind === 'session' ? state.sessions[state.view.ref] : undefined;
	const screenDescription = sessionOnScreen
		? `looking at ${sessionOnScreen.ref}${sessionOnScreen.isPinned ? ' (the crew setup session: a separate Claude, not you)' : ''}${sessionOnScreen.topic ? ` (${sessionOnScreen.topic})` : ''}. What the developer says is for ${sessionOnScreen.ref} unless they name another session, answer something that waits, or give you a command`
		: 'looking at all sessions (Mission Control)';
	const sessions = state.order.map((ref) =>
		describeSession({ state, ref, isDetailed: false, now }),
	);
	const waiting = listWaitingItems(state, now);
	const lastAskedLine = findLastAskedAloud(state, waiting, now);

	return [
		`Screen: ${screenDescription}.`,
		`Sessions: ${JSON.stringify(sessions)}`,
		`Waiting on the developer: ${formatWaitingLine(waiting, now, lastAskedLine?.ref ?? null)}`,
		`Voice OS last asked aloud: ${describeAskedAloud(lastAskedLine, now)}`,
		`Earlier on this screen (already done — act only on what the developer says now):\n${formatRememberedLines(memory)}`,
		'',
		`Developer said: ${utterance}`,
	].join('\n');
};

export const extractReplyText = (content: Anthropic.ContentBlock[]): string => {
	return content
		.filter((block): block is Anthropic.TextBlock => block.type === 'text')
		.map((block) => block.text)
		.join(' ')
		.trim();
};

export interface KernelResult {
	reply: string;
	calls: ToolCall[];
	// One line per call that changed something: the voice log's record.
	did: string[];
}

export type KernelTools = Omit<
	ToolContext,
	'now' | 'utterance' | 'recentUtterances' | 'forwardTo' | 'screen' | 'isSpoken' | 'asks'
>;

export interface KernelOptions {
	apiKey: string;
	tools: KernelTools;
	model?: string;
	client?: Anthropic;
	now?: () => number;
}

export interface KernelHandleParams {
	// The session on screen when the words were said.
	forwardTo?: string | null;
	screen?: Screen;
	// Spoken, not typed: a spoken follow-up can interrupt the reply it follows.
	isSpoken?: boolean;
}

interface RequestParams {
	messages: Anthropic.MessageParam[];
	forwardTo: string | null;
	toolsOff?: boolean;
}

export class Kernel {
	private client: Anthropic;
	private now: () => number;

	constructor(private options: KernelOptions) {
		this.client =
			options.client ?? new Anthropic({ apiKey: options.apiKey, maxRetries: 2, timeout: 30_000 });
		this.now = options.now ?? Date.now;
	}

	async handle(
		utterance: string,
		{ forwardTo = null, screen = null, isSpoken = false }: KernelHandleParams = {},
	): Promise<KernelResult> {
		const startedAt = this.now();
		const calls: KernelResult['calls'] = [];
		const state = this.options.tools.getState();
		// screen was captured at routing: a switch_view during this call does not move the words.
		const memory = recallVoiceEntries(state, screen, startedAt);
		const messages: Anthropic.MessageParam[] = [
			{ role: 'user', content: buildKernelMessage({ state, utterance, memory, now: startedAt }) },
		];
		const toolContext: ToolContext = {
			...this.options.tools,
			utterance,
			recentUtterances: memory.map((entry) => entry.utterance),
			forwardTo,
			screen,
			isSpoken,
			// The asks as they stood when the words were said: an answer never lands on one that opened since.
			asks: state.asks,
			now: this.now,
		};
		// Built up step by step: a later step's text replaces an earlier one, a silent step ends the loop.
		let reply = '';
		let isSilent = false;

		for (let step = 0; step < MAX_STEPS; step++) {
			const response = await this.request({ messages, forwardTo });
			const text = extractReplyText(response.content);

			// The model often answers first and then checks with a tool: an empty last step must not erase it.
			if (text) {
				reply = text;
			}

			const toolUses = response.content.filter(
				(block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
			);
			// cached: prompt tokens read from the prompt cache (the system prompt and tools, ~4.5k).
			const usage = response.usage as Anthropic.Usage | undefined;
			log.debug('step', {
				step,
				stop: response.stop_reason,
				tools: toolUses.map((toolUse) => toolUse.name),
				chars: text.length,
				input: usage?.input_tokens,
				cached: usage?.cache_read_input_tokens,
			});

			if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
				break;
			}

			messages.push({ role: 'assistant', content: response.content });
			const results = await Promise.all(
				toolUses.map(async (toolUse) => {
					const input = (toolUse.input ?? {}) as Record<string, unknown>;
					const result = await executeTool(toolUse.name, input, toolContext);
					calls.push({ name: toolUse.name, input, ok: result.ok });
					log.info('tool', { name: toolUse.name, ok: result.ok });

					return {
						type: 'tool_result' as const,
						tool_use_id: toolUse.id,
						content: result.content,
						is_error: !result.ok,
					};
				}),
			);
			// Every result of one response goes back in a single message.
			messages.push({ role: 'user', content: results });

			// Silent calls that worked need no second model call; text beside them is still the answer.
			if (
				toolUses.every((toolUse) =>
					isSilentCall(toolUse.name, (toolUse.input ?? {}) as Record<string, unknown>),
				) &&
				results.every((result) => !result.is_error)
			) {
				isSilent = true;
				break;
			}
		}

		if (!reply && !isSilent && calls.length > 0) {
			// Silence after tools reads as broken, so the model is asked once more, tools off.
			log.warn('no answer after tools, asking again', { calls: calls.map((call) => call.name) });
			reply = await this.answerNow(messages, forwardTo);
		}

		const did = calls.map(describeToolCall).filter((line): line is string => line !== null);
		log.info('handled', {
			ms: this.now() - startedAt,
			screen,
			calls: calls.map((call) => call.name),
			reply,
		});

		return { reply, calls, did };
	}

	private request({ messages, forwardTo, toolsOff = false }: RequestParams) {
		return this.client.messages.create({
			model: this.options.model ?? KERNEL_MODEL,
			max_tokens: 1024,
			// A router: the same words must go the same way every time.
			temperature: 0,
			system: [{ type: 'text', text: KERNEL_SYSTEM, cache_control: { type: 'ephemeral' } }],
			// The history can hold tool calls, so the tools stay declared even when none may run.
			tools: listToolsFor(forwardTo) as unknown as Anthropic.Tool[],
			...(toolsOff ? { tool_choice: { type: 'none' as const } } : {}),
			messages,
		});
	}

	private async answerNow(
		messages: Anthropic.MessageParam[],
		forwardTo: string | null,
	): Promise<string> {
		const lastMessage = messages.at(-1);
		const nudge = {
			type: 'text' as const,
			text: 'Now answer the developer out loud in one short sentence.',
		};
		const messagesWithNudge: Anthropic.MessageParam[] =
			lastMessage?.role === 'user' && Array.isArray(lastMessage.content)
				? [...messages.slice(0, -1), { role: 'user', content: [...lastMessage.content, nudge] }]
				: [...messages, { role: 'user', content: [nudge] }];
		const response = await this.request({ messages: messagesWithNudge, forwardTo, toolsOff: true });

		return extractReplyText(response.content);
	}
}

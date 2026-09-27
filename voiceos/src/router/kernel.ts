import Anthropic from '@anthropic-ai/sdk';
import {
	GRID,
	isOfferFresh,
	isRemembered,
	type PendingAsk,
	type SpokenLine,
	type State,
	type VoiceEntry,
} from '../shared/protocol.js';
import { formatAge } from '../state/working.js';
import { createLogger } from '../log.js';
import { executeTool, type ToolContext } from '../tools/tools.js';
import { isSilentCall, describeToolCall, decideEnding } from '../tools/call-lines.js';
import {
	listToolsFor,
	MUTATING_TOOLS,
	type ToolCall,
	type ToolName,
} from '../tools/definitions.js';
import { fail } from '../tools/results.js';
import { describeSession } from '../tools/session-view.js';
import { findLastAskedAloud } from '../tools/asked-aloud.js';
import { findSessionsNamedIn } from '../tools/session-naming.js';

const log = createLogger('kernel');
export const KERNEL_MODEL = 'claude-haiku-4-5';
const MAX_STEPS = 4;

export const KERNEL_SYSTEM = `You are the voice kernel of Voice OS: a developer runs several Claude Code sessions, one per git worktree, and talks to you instead of clicking. Everything they say reaches you, and you decide what happens: pass it to a session, answer what a session is waiting on, act on Voice OS itself, or say nothing.

When the screen shows one session (see "Screen:"):
- Speech meant for that session goes to it: instructions, questions about the code, its logs or the work, replies to what it said, thinking out loud about the task. Do not answer it yourself: call forward with it written as a clear instruction or question to that Claude, in the developer's voice. Drop relay words ("can you ask it to", "tell it to") and false starts; keep every detail, name, number, negation and reaction; add nothing they did not say. "can you ask it to check the logs" is forward "Check the logs." "hmm, I don't like that, revert it" is forward "I don't like that — revert it." "why is this so slow", "run the tests", "yes but use the table" are for the session — and so is anything about the work that is not a Voice OS command or a status question: "do you remember what we said we'd do next?", "what's the last thing we've done?", "where were we?", "check the transcripts and let me know", "where is that code, which branch?", "could we brainstorm, use proxy brainstorm", "go through my notes and pick one". That Claude holds the whole conversation and you only see its last lines, so never answer those yourself from read_history or read_state, and never ask back. Keep names of skills, commands and tools exactly as said ("proxy brainstorm").
- When the developer's words finish a sentence their previous words on this screen began, cut off by a pause ("check the logs for the timeout errors in" then "the checkout worker from this morning"), forward it with continues true: text is the whole sentence, rest only the new part. Voice OS replaces the first half with it. A new request, an added task ("also run the linter") or an answer is never this.
- The pinned setup session is a session like any other: when it is on screen, forward speech to it.
- "Voice OS" is this app (you and the cockpit): rebuilding, reinstalling, restarting, fixing or changing Voice OS is work for the session on screen — forward it.
- When unsure whether speech is for the session on screen, forward it: the session can ask back. Do not ask the developer which session they mean while one is on screen, unless they named two, and never ask who something is for ("crew/main or Voice OS?"): forward it.
- On a session screen your first step always calls a tool. To answer a question yourself from the message (what's waiting, is it done, what did it say, did you send that), call read_state first, then answer. ignore_words only for words that ask for nothing or were not said to anyone (a video, a song, someone else talking). Never forward a command for Voice OS: opening, switching or going back, starting, stopping or interrupting sessions, quiet, and questions about which sessions are waiting, running or doing what — those are yours, even when they begin "Voice OS, …".
- Words that happen to match another session's topic do not make it about that session: the developer is talking to the session in front of them. Only an explicit reference switches the target — "tell checkout…", "in the ranking one…", "checkout, run the tests", "open…".
- An instruction that names another session goes to it: "have checkout run the migrations" while store front is on screen is send_to the checkout session.
- Instructions about how the session should work or talk to the developer — "ask me with the question tool…", "use a table", "reply in one line" — are for that session: forward them.

Answering what a session waits on (see "pending", "asked" and "Voice OS last asked aloud"):
- "pending" is an open permission, plan or question: answer it with the answer tool, never by forward. Only a clear yes, no, always or choice answers it — "hmm" is thinking. A question about what it waits on ("why does step 3 touch the kernel?", "what does that command do?") is forward with kind question: it is answered aside and the plan or permission keeps waiting. Anything else the developer says for that session — a new instruction, a change of subject ("also run the linter") — is them moving on: forward it as said. It reaches the session and declines the permission or plan with their words. Never tell them it is waiting, never ask them to answer it first. For a permission or plan, "yes", "okay", "sure", "go ahead", "do it" are yes; "always" is always; "no …" is no with the rest as text ("No, use a new branch" is no with "use a new branch"). "Yes, but only on staging" is answer yes with text "Only on staging." — the text reaches the session with the answer. For a question, choose the listed option the developer meant — "the second one" is the second label, "reuse it" is "Reuse orders" — or their own words when none fits; keep detail they add to an option ("New table, partitioned").
- "asked" is a question a session ended its turn on: the developer's reply is its answer. forward it (or send_to when that session is not on screen) as they said it; never ask them the question again, never read_state first. Whatever they say next for that session — a full answer, part of one, a correction or something else entirely — goes to it as said: never ask them to choose, confirm what they meant, or answer it first. A question from the developer is never an answer — "so pushing won't expose the keys?" is a new question: forward it, and never call answer or say the session is waiting on them.
- A bare reply ("yes", "no", "do it", "go ahead") answers whatever was just asked aloud (see "Voice OS last asked aloud"): a session's pending or asked question, or Voice OS's own fix offer ("…want Claude to fix it?" — dev_offer). That may not be the session on screen. When "Waiting on the developer" lists one thing, a bare reply answers it from any screen — do not ask which. When two or more wait, "Voice OS last asked aloud" says which; ask which only when nothing does. One bare reply answers one thing, never several.
- When nothing waits, a reply on a session's screen ("yes, but use the table", "no, the other file") is for that session: forward it.
- A yes meant for a fix offer is always dev_offer, however old: it says when the offer lapsed, and then you tell the developer. Never crew_dev, send_to or forward in its place.
- "Options", "what are the options": a pending question lists its options — read them out, briefly and numbered. Otherwise read_state the session that asked and list the options it actually offered in its recent output — that list may be longer than one sentence. If it offered none, reply exactly "Nothing is waiting on a choice." and nothing more — what the developer asked a session for is not a question it asked back; never take options from your own earlier words or the developer's. Never forward it.
- "Allow it", "let it" after auto mode blocked something ("blocked") is allow_denied.
- "Slash clear", "slash compact …" are commands for the session: forward them as "/clear", "/compact …". Voice OS then asks the developer to confirm, and that confirm shows as pending: answer it with answer yes or no. While one waits, "no", "cancel", "don't" answer it no — they never interrupt. The same goes for Voice OS asking "…Stop it and switch?" about a redirect: it shows as pending (switch_to); answer it with answer yes or no, and words the developer adds go in text.
- Reading back — only "what did it say?", "what did the session say?", "read it out": read_state that session (the one on screen unless they named another) and speak its last_reply in its own words, for the ear: the point first, then the details that matter — names, numbers, what it found, what it recommends — in two to four sentences, at most 80 words, no code, paths or tables. Never summarize it down to a line. Asking it for more is a question for the session: forward it.

Voice OS itself:
- open, switch to, show, go to X → switch_view X. X may be what a session works on ("back to where we're doing the data analysis"): match it against each session's last_messages_to_it and topic. Home, go back, Mission Control, show me everything → switch_view with null.
- start X → start_session (it also opens X). end, close, stop session X → stop_session.
- stop, wait, hold on, cancel → interrupt the session on screen when it is working (status running or blocked). Only when that is all they say: "stop the refactor and fix the login bug first" names what to do instead — forward it with kind redirect and do not interrupt; Voice OS asks them whether to switch. A question or instruction that changes how the running work is done ("can we use proxy pair?", "no, use X for this") is kind redirect too. "Don't queue it", "I want it now", "do that first" about words already queued → queued_message now, never interrupt alone; "take that back", "don't send that" → queued_message drop. On Mission Control, with no session named, never interrupt: when a session is working, ask in a few words whether to stop it; otherwise it only meant Voice OS should stop talking — ignore_words.
- quiet, shut up, mute → mute.
- hands-free on or off, "stop listening", "start listening" → hands_free. A bare "stop" is never this.
- "note: …", "add a note …", "note that …" (without "debug") → note with their words after it, as said; it is their own idea or reminder, never for the session. Reply "Noted." "What are my notes?" → read_notes, then read them back briefly: only to hear them. A "note that …" that goes on to ask for work ("note that the API changed, update the client") is for the session: forward it. Asking a session to go through, pick from or work on "my notes" is work for it: forward that (Voice OS tells it where they are).
- "debug note: …", "add a debug note …" → debug_note with their words after it, as said. It is for Voice OS's own debugging: never forward it to a session. Reply "Noted." Asking the session to read or analyze the debug notes is work for it: forward that.
- What another session is doing — "what's the setup status?", "what's checkout doing?", "check on it", "is it done?": find the session by what it was asked (last_messages_to_it; the setup session is setup) or its topic, and answer from its status, working_for and those messages. For more detail call read_state on it — it shows its latest steps. Never send a busy session a question to find out: it would wait behind its work or disturb it. A question about the work itself ("which file did you change?") is for the session: forward it with kind question, and a working session answers it aside.

Rules:
- Never remind the developer that a session waits on them unless they asked what is waiting.
- Use tools; never describe an action instead of taking it. A request for several things gets all of them in one response: "restart the dev servers and have it check the logs" is crew_dev restart and forward "Check the logs." together.
- "Earlier on this screen" is done. Act only on what the developer says now, and never repeat an earlier action unless they ask for it again: after a restart, "also start the session" is start_session alone. Asked about what you did with their words ("did you send that?", "that should have gone to the session, right?"), answer from it in a few words ("Yes, it went to store-front/main.") — never send it again.
- Opening, switching to or showing a session only shows it: never call start_session unless the developer asked to start it. forward and send_to start a stopped session by themselves: words meant for a session always go through forward or send_to, never through start_session.
- Words that ask for nothing and want nothing done — a thought that stops before saying what it wants ("and can you", "let's, um", or a name ending in a dash like "store front main—": the developer was cut off), or only a greeting or acknowledgement ("okay", "hey", "thanks", "hmm") with nothing waiting on an answer — call ignore_words alone and write no text, not even "I'm listening". Filler or a false start in front of a request never makes it this: "Hmm, let's start this." is a request to start the session on screen (on Mission Control, where "this" names nothing, ask which session), and "And can you tell me what's running?" is a question to answer. A question always gets a spoken answer.
- Dev servers: a session lists its servers under dev_servers only when some are not running. "What's wrong with the dev servers" or "are they up" you answer yourself, from dev_servers and their detail, without crew_dev status and without forwarding — a question is answered, never passed on as work nobody asked for. Only when the developer asks for work — look into why, check the logs, fix them — does it go to that session's Claude: forward (or send_to) it there; sending starts a stopped session.
- Every session's status, topic, what it waits on and what it was last asked are already in the message: answer from them. Call read_state only when you need a session's recent output or steps, read_history for what it did before. Never guess.
- Refer to sessions by the ref the state lists. The developer may name a session by its topic ("the ranking work") — match it against topics. Worktree names are spoken as words: "work one" is wrk1, "store front" is store-front. Speech-to-text writes some spoken numbers as digits: "the checkout retry 1" is "the checkout retry one" (the one about retries), not wrk1 — a digit names a worktree only right after "work".
- When exactly one session matches a name or topic, act on it — never ask "did you mean X?" about the only match.
- Never ask the same question twice: after a reply that does not answer it ("yes" to an either-or), go with the likelier choice and carry out what they asked before it — send those earlier words, not the "yes".
- Ask one short question, and change nothing — one sentence, never a list of sessions — only when two or more sessions really match (for example "main" when several workspaces have a main worktree), or, on Mission Control, when you cannot tell what to do — on a session's screen, forward instead. Never guess which session to stop, start or send to: "Which session should run the tests?", not the sessions listed.
- On Mission Control (no session on screen), send_to only when the developer clearly asked for work or an answer in a session, written as a clear instruction as above. Never invent instructions.
- Setup work is only the crew CLI adding or removing workspaces, projects and worktrees, and belongs to the pinned setup session: send_to it with the developer's request. It asks for permission before anything destructive. Dev servers, crew fix and verify, agents, sub-agents, tests and code are never setup: they are the work of that worktree's session; on Mission Control, a sub-agent or test with no session named ("create a sub-agent") asks which session. start_session only starts existing worktrees.
- Reply for the ear in one short sentence — at most 15 words unless the developer asked for detail, a list or a read-back — with the fact only: "Two sessions are waiting: checkout and ranking." not "I checked the state and found that two sessions are currently waiting on you." No code, no paths, no markdown. Navigation, forwarding, answering, interrupting and starting or stopping dev servers need no reply; every question gets a spoken answer, even when the answer is "nothing is waiting".`;

export type Screen = string | null;

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
	const lastAskedLine = findLastAskedAloud({
		spoken: state.spoken,
		waitingRefs: waiting.map((item) => item.ref),
		now,
	});

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
	| 'now'
	| 'utterance'
	| 'recentUtterances'
	| 'forwardTo'
	| 'screen'
	| 'isSpoken'
	| 'asks'
	| 'setHandsFree'
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
	// Switches hands-free in the tab the words came from.
	setHandsFree?: ToolContext['setHandsFree'];
}

interface RequestParams {
	messages: Anthropic.MessageParam[];
	forwardTo: string | null;
	toolChoice?: Anthropic.ToolChoice;
}

interface ReadRunOrderParams {
	name: string;
	input: unknown;
	asks: PendingAsk[];
}

export const readRunOrder = ({ name, input, asks }: ReadRunOrderParams): number => {
	// A fix offer first; an answer with nothing pending to answer (it falls back to sending the
	// words) last, after any forward beside it. Everything else keeps the model's order.
	if (name === 'dev_offer') {
		return 0;
	}

	const ref = (input as { ref?: unknown } | null)?.ref;

	return name === 'answer' && !asks.some((ask) => ask.ref === ref) ? 2 : 1;
};

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
		{
			forwardTo = null,
			screen = null,
			isSpoken = false,
			setHandsFree = () => 'no_tab',
		}: KernelHandleParams = {},
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
			setHandsFree,
			// The asks as they stood when the words were said: an answer never lands on one that opened since.
			asks: state.asks,
			sentTo: new Set(),
			now: this.now,
		};
		// Built up step by step: a later step's text replaces an earlier one, a silent step ends the loop.
		let reply = '';
		let isSilent = false;
		// A tool asked for an answer with no more tools (a lapsed fix offer: nothing else may be sent).
		let mustAnswerNow = false;
		let mustActAgain = false;

		for (let step = 0; step < MAX_STEPS; step++) {
			// On a session screen the first step must act: no filler ("I'm listening") and no asking back there.
			// A later step can still ask back; decideEnding catches that.
			const response = await this.request({
				messages,
				forwardTo,
				...(forwardTo && (step === 0 || mustActAgain)
					? { toolChoice: { type: 'any' as const } }
					: {}),
			});
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
			// One at a time: once a result is final, nothing else that changes anything may run (a
			// lapsed offer beside a send_to would still send the fix).
			const runOrderOf = (toolUse: Anthropic.ToolUseBlock) =>
				readRunOrder({ name: toolUse.name, input: toolUse.input, asks: toolContext.asks });
			const ordered = [...toolUses].sort((left, right) => runOrderOf(left) - runOrderOf(right));
			const resultsById = new Map<string, Anthropic.ToolResultBlockParam>();

			// A long sentence split across several actions is not one rewrite that lost its point.
			const isAction = (name: string) => MUTATING_TOOLS.includes(name as ToolName);
			toolContext.actionsInTurn =
				calls.filter((call) => call.ok && isAction(call.name)).length +
				toolUses.filter((toolUse) => isAction(toolUse.name)).length;

			for (const toolUse of ordered) {
				const input = (toolUse.input ?? {}) as Record<string, unknown>;
				const isBlocked = mustAnswerNow && MUTATING_TOOLS.includes(toolUse.name as ToolName);
				const result = isBlocked
					? fail('not run: an earlier result in this turn ended it')
					: await executeTool(toolUse.name, input, toolContext);

				calls.push({
					...(result.recordAs ?? { name: toolUse.name, input }),
					ok: result.ok,
					...(result.note ? { note: result.note } : {}),
				});
				log.info('tool', {
					name: toolUse.name,
					ok: result.ok,
					// Why words were ignored is the first question when a developer says they were lost.
					...(toolUse.name === 'ignore_words' ? { reason: input.reason } : {}),
					...(isBlocked ? { blocked: true } : {}),
				});

				if (result.isFinal) {
					mustAnswerNow = true;
				}

				resultsById.set(toolUse.id, {
					type: 'tool_result',
					tool_use_id: toolUse.id,
					content: result.content,
					is_error: !result.ok,
				});
			}

			const results = toolUses.flatMap((toolUse) => resultsById.get(toolUse.id) ?? []);
			// Every result of one response goes back in a single message.
			messages.push({ role: 'user', content: results });

			// A refused ignore_words must be followed by a choice, not a spoken "is that right?".
			mustActAgain = toolUses.some(
				(toolUse, index) => toolUse.name === 'ignore_words' && results[index]?.is_error,
			);

			// Calls made beside it in the same response have already run; nothing after it may.
			if (mustAnswerNow) {
				break;
			}

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

		const ending = decideEnding({
			reply,
			calls,
			forwardTo,
			utterance,
			namedRefs: findSessionsNamedIn(state, utterance),
			isSilent,
			mustAnswerNow,
		});

		switch (ending.kind) {
			case 'forward_utterance': {
				log.info('asked back on a session screen: forwarding instead', { reply });
				const input = {
					text: utterance,
					kind: /\?\s*$/.test(utterance) ? 'question' : 'instruction',
				};
				const result = await executeTool('forward', input, toolContext);

				calls.push({
					name: 'forward',
					input,
					ok: result.ok,
					...(result.note ? { note: result.note } : {}),
				});
				reply = result.ok ? '' : reply;
				break;
			}
			case 'drop_reply':
				if (reply) {
					log.info('reply dropped beside a forward', { chars: reply.length });
				}

				reply = '';
				break;
			case 'answer_now':
				log.warn(
					ending.reason === 'final'
						? 'answering without tools'
						: 'no answer after tools, asking again',
					{
						calls: calls.map((call) => call.name),
					},
				);
				reply = await this.answerNow(messages, forwardTo);
				break;
			case 'keep':
				break;
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

	private request({ messages, forwardTo, toolChoice }: RequestParams) {
		return this.client.messages.create({
			model: this.options.model ?? KERNEL_MODEL,
			max_tokens: 1024,
			// A router: the same words must go the same way every time.
			temperature: 0,
			system: [{ type: 'text', text: KERNEL_SYSTEM, cache_control: { type: 'ephemeral' } }],
			// The history can hold tool calls, so the tools stay declared even when none may run.
			tools: listToolsFor(forwardTo) as unknown as Anthropic.Tool[],
			...(toolChoice ? { tool_choice: toolChoice } : {}),
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
		const response = await this.request({
			messages: messagesWithNudge,
			forwardTo,
			toolChoice: { type: 'none' },
		});

		return extractReplyText(response.content);
	}
}

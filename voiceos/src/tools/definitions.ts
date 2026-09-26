import { ANSWER_DECISIONS } from './answer.js';

export type ToolName =
	| 'forward'
	| 'read_state'
	| 'read_history'
	| 'send_to'
	| 'switch_view'
	| 'start_session'
	| 'stop_session'
	| 'crew_dev'
	| 'ignore_words'
	| 'answer'
	| 'interrupt'
	| 'mute'
	| 'dev_offer'
	| 'allow_denied'
	| 'debug_note';

export const MUTATING_TOOLS: ToolName[] = [
	'forward',
	'send_to',
	'start_session',
	'stop_session',
	'crew_dev',
	'answer',
	'interrupt',
	'mute',
	'dev_offer',
	'allow_denied',
	'debug_note',
];

interface JsonSchema {
	type: 'object';
	properties: Record<string, unknown>;
	required: string[];
	additionalProperties: false;
}

export interface ToolCall {
	name: string;
	input: Record<string, unknown>;
	ok: boolean;
}

export interface ToolDefinition {
	name: ToolName;
	description: string;
	// Not strict: strict schemas cost ~1 s per call and a cold start; executeTool validates anyway.
	input_schema: JsonSchema;
}

const REF_PROPERTY = {
	type: 'string',
	description: 'A session ref exactly as listed in the state, like "store-front/main".',
};

const CLEAN_INSTRUCTION =
	'What the developer wants, written to that Claude in their voice as a clear instruction or question: drop relay words ("can you ask it to", "tell it"), filler and false starts; keep every detail, name, number, negation and reaction; add nothing they did not say.';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
	// ignore_words must be listed first: listed later, the model narrates its silence instead.
	{
		name: 'ignore_words',
		description:
			'Only when the words ask for nothing and want nothing done: a thought that stops before saying what it wants ("and can you", "let\'s, um", a name cut off with a dash), or only a greeting or acknowledgement ("hey", "okay", "thanks", "hmm"). Call it alone, with no text: nothing happens and nothing is said. Filler in front of a request does not make it this ("hmm, let\'s start this" is a request); a question, or an ambiguous name to ask about, is never this. A complete sentence is never an unfinished thought, even when what it refers to is unclear — ask which one instead.',
		input_schema: {
			type: 'object',
			properties: {
				// The reason makes the model name what it heard; a question fits neither.
				reason: { type: 'string', enum: ['unfinished thought', 'greeting or acknowledgement'] },
			},
			required: ['reason'],
			additionalProperties: false,
		},
	},
	{
		name: 'read_state',
		description:
			'Recent output lines of one session, or of all. Status, topic and what each session waits on are already in the message; call this only when the answer needs what a session actually printed.',
		input_schema: {
			type: 'object',
			properties: {
				ref: {
					type: ['string', 'null'],
					description: 'One session ref, or null for every session.',
				},
			},
			required: ['ref'],
			additionalProperties: false,
		},
	},
	{
		name: 'read_history',
		description:
			'What was asked and done in past turns, newest first, across restarts. For "what did X do yesterday" or finding a session by past work.',
		input_schema: {
			type: 'object',
			properties: {
				ref: { type: ['string', 'null'], description: 'One session ref, or null for all.' },
				query: {
					type: ['string', 'null'],
					description: 'Words to match in what was asked or done, or null.',
				},
				limit: { type: 'integer', description: 'Most entries to return (1-20).' },
			},
			required: ['ref', 'query', 'limit'],
			additionalProperties: false,
		},
	},
	{
		name: 'send_to',
		description:
			'Send the developer’s request to a session’s Claude as a clear instruction or question to it. Only when the developer clearly asked for work or an answer there. A stopped session starts by itself.',
		input_schema: {
			type: 'object',
			properties: { ref: REF_PROPERTY, text: { type: 'string', description: CLEAN_INSTRUCTION } },
			required: ['ref', 'text'],
			additionalProperties: false,
		},
	},
	{
		name: 'switch_view',
		description: 'Show one session on screen, or every session (Mission Control) when ref is null.',
		input_schema: {
			type: 'object',
			properties: { ref: { type: ['string', 'null'] } },
			required: ['ref'],
			additionalProperties: false,
		},
	},
	{
		name: 'start_session',
		description:
			'Start (or resume) the Claude session of an existing worktree, when the developer asks to start it and gives it nothing to do. To give a session words or work, use forward or send_to: they start it themselves. It does not create worktrees.',
		input_schema: {
			type: 'object',
			properties: { ref: REF_PROPERTY },
			required: ['ref'],
			additionalProperties: false,
		},
	},
	{
		name: 'stop_session',
		description: 'End a session’s Claude process. Its conversation resumes on the next start.',
		input_schema: {
			type: 'object',
			properties: { ref: REF_PROPERTY },
			required: ['ref'],
			additionalProperties: false,
		},
	},
	{
		name: 'crew_dev',
		description: 'Start, stop, restart or check the dev servers of a worktree.',
		input_schema: {
			type: 'object',
			properties: {
				ref: REF_PROPERTY,
				action: { type: 'string', enum: ['start', 'stop', 'restart', 'status'] },
			},
			required: ['ref', 'action'],
			additionalProperties: false,
		},
	},
	{
		name: 'answer',
		description:
			'Answer what a session is waiting on — its pending permission, plan or question (listed under "pending") — only when the developer answered it. An instruction that is not an answer ("also run the linter") is never a yes: do not call this; tell them it waits on its permission first. yes / always / no for a permission, yes / no for a plan — text is what the developer added, as an instruction ("Yes, but push to a new branch" is yes with "Push to a new branch afterwards."; with no it is what to do instead), sent to the session with the answer; choose for a question, with text exactly one of its listed option labels (you work out which one the developer meant) or, when none fits, their own words. Not for a question a session asked at the end of its turn ("asked"): forward or send_to the reply instead. One reply answers one session: when several wait and neither the words nor "Voice OS last asked aloud" say which, do not call it — ask which.',
		input_schema: {
			type: 'object',
			properties: {
				ref: REF_PROPERTY,
				decision: { type: 'string', enum: [...ANSWER_DECISIONS] },
				text: {
					type: 'string',
					description:
						"The option, the reason, or the developer's words; empty when there is nothing to add.",
				},
			},
			required: ['ref', 'decision', 'text'],
			additionalProperties: false,
		},
	},
	{
		name: 'interrupt',
		description:
			'Stop what a session\'s Claude is doing right now ("stop", "wait", "hold on"): its current turn ends, the session stays open. Only the session on screen or one the developer named.',
		input_schema: {
			type: 'object',
			properties: { ref: REF_PROPERTY },
			required: ['ref'],
			additionalProperties: false,
		},
	},
	{
		name: 'mute',
		description:
			'The developer wants Voice OS quiet ("quiet", "shut up", "mute"): chatter stops, questions that need them still speak.',
		input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
	},
	{
		name: 'dev_offer',
		description:
			"Answer Voice OS's own offer to have a session's Claude fix its failing dev servers (listed as fix_offer): accept true to fix, false to let it go.",
		input_schema: {
			type: 'object',
			properties: { accept: { type: 'boolean' } },
			required: ['accept'],
			additionalProperties: false,
		},
	},
	{
		name: 'allow_denied',
		description:
			'Let a session do once what auto mode just blocked (listed as "blocked") — "allow it", "let it".',
		input_schema: {
			type: 'object',
			properties: { ref: REF_PROPERTY },
			required: ['ref'],
			additionalProperties: false,
		},
	},
	{
		name: 'debug_note',
		description:
			'The developer flags something that just went wrong, for debugging later ("debug note: …", "add a debug note …"). Voice OS saves their words with a snapshot of this moment beside its log. text: what they said after the trigger, as said.',
		input_schema: {
			type: 'object',
			properties: { text: { type: 'string' } },
			required: ['text'],
			additionalProperties: false,
		},
	},
];

export const FORWARD_TOOL: ToolDefinition = {
	name: 'forward',
	description:
		'Send what the developer just said to the session on screen as a clear instruction or question to its Claude. Use it for anything they say to that session: instructions, questions about the code, logs or the work, replies, reactions. A stopped session starts by itself.',
	input_schema: {
		type: 'object',
		properties: { text: { type: 'string', description: CLEAN_INSTRUCTION } },
		required: ['text'],
		additionalProperties: false,
	},
};

export const listToolsFor = (forwardTo: string | null): ToolDefinition[] => {
	// Offered only while a session is on screen: a tool that needs no ref is chosen reliably and fast.
	return forwardTo ? [FORWARD_TOOL, ...TOOL_DEFINITIONS] : TOOL_DEFINITIONS;
};

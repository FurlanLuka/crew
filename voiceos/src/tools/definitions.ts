import { ANSWER_DECISIONS } from './answer.js';
import { DELIVER_WISHES } from '../state/delivery.js';

export type ToolName =
	| 'forward'
	| 'read_state'
	| 'read_history'
	| 'send_to'
	| 'switch_view'
	| 'go_back'
	| 'play_missed'
	| 'activate'
	| 'deactivate'
	| 'list_sessions'
	| 'crew_dev'
	| 'ignore_words'
	| 'rename_session'
	| 'answer'
	| 'interrupt'
	| 'mute'
	| 'dev_offer'
	| 'allow_denied'
	| 'debug_note'
	| 'note'
	| 'read_notes'
	| 'queued_message'
	| 'hands_free'
	| 'rename_machine'
	| 'open_doc';

export const MUTATING_TOOLS: ToolName[] = [
	'forward',
	'send_to',
	'go_back',
	'activate',
	'deactivate',
	'crew_dev',
	'answer',
	'interrupt',
	'mute',
	'dev_offer',
	'allow_denied',
	'debug_note',
	'note',
	'queued_message',
	'hands_free',
	'rename_machine',
	'rename_session',
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
	note?: string;
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

const KIND_PROPERTY = {
	type: 'string',
	enum: ['question', 'instruction', 'redirect'],
	description:
		'question: the developer asks something that Claude can answer from what it already knows or did. instruction: anything asking for work, a change or a check — and a question that means the current work should change ("shouldn\'t that use v2?"). redirect: an instruction that stops or replaces what that Claude is doing right now, or changes how it does it, not something for after it ("actually, stop the refactor and fix the login bug first", "don\'t do the migration, do the seed script instead", "can we use proxy pair for this?", "no, use proxy pair"); "also run the linter" is an instruction, not a redirect.',
};

const CONTINUES_PROPERTY = {
	type: 'boolean',
	description:
		'true only when these words finish the sentence the developer began in their previous words on this screen (listed under "Earlier on this screen"), cut off by a pause — their previous words stop mid-sentence ("why are the retries so") and these pick up where they stopped ("slow on the checkout worker?"). Voice OS joins the two halves as said. A new request, an added task or a reply is not this.',
};

const SKIP_HELD_PROPERTY = {
	type: 'boolean',
	description:
		"true when you also send_to that session the developer's question in this turn: its old held update is not replayed first.",
};

// One property for both switch_view definitions: a machine switch must not lose "go to active".
const ACTIVE_VIEW_PROPERTY = {
	type: 'boolean',
	description:
		'true for Active, the developer\'s active sessions from every machine ("go to active", "show my active sessions"); ref and machine are then ignored.',
};

// Judged by the kernel in the developer's own language: no English keyword decides these.
const MY_NOTES_PROPERTY = {
	type: 'boolean',
	description:
		'Whether the developer mentions their own notes, in any language ("my notes", "meine Notizen", "moje beležke"): the session is told where they are. Not the release notes, not debug notes.',
};

const ABOUT_LAST_ACTION_PROPERTY = {
	type: 'boolean',
	description:
		'true when the words point back at what Voice OS itself just did or saved, in any language ("check this debug note", "schau dir die Notiz an", "poglej ta zapisek"): the session is told what it was.',
};

// Read by the kernel in whatever language was spoken; only a busy session is affected.
const DELIVER_PROPERTY = {
	type: 'string',
	enum: [...DELIVER_WISHES],
	description:
		'Only when the developer says how the words should reach a working session, in any language: aside — "by the way", "übrigens", a quick side question; queue — after its current work ("queue it"); now — instead of its current work ("send it now"). Leave out otherwise.',
};

// The kernel never writes what a session reads: Voice OS sends the words as heard.
const PART_PROPERTY = {
	type: 'string',
	description:
		'Leave out: Voice OS sends everything the developer said, exactly as heard. Only when the same words also did something else (a switch, a note, words for another session): the part for this session, copied word for word from what they said — never reworded, shortened or cleaned up. To resend their earlier words ("I meant this for store front main", or a yes to your own "want me to ask it?"): those words, copied word for word.',
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
	// ignore_words must be listed first: listed later, the model narrates its silence instead.
	{
		name: 'ignore_words',
		description:
			'Only when the words ask for nothing and want nothing done: a thought that stops before saying what it wants ("and can you", "let\'s, um", a name cut off with a dash), or only a greeting or acknowledgement ("hey", "okay", "thanks", "hmm"). Call it alone, with no text: nothing happens and nothing is said. Filler in front of a request does not make it this ("hmm, let\'s start this" is a request); a question, or an ambiguous name to ask about, is never this. A complete sentence is never an unfinished thought, even when what it refers to is unclear — ask which one instead. Also for speech not said to Voice OS or a session: a video, a song, someone else talking ("add in about that much ketchup"). Thinking out loud about the work is not this: it is for the session.',
		input_schema: {
			type: 'object',
			properties: {
				// The reason makes the model name what it heard; a question fits neither.
				reason: {
					type: 'string',
					enum: ['unfinished thought', 'greeting or acknowledgement', 'not said to anyone'],
				},
			},
			required: ['reason'],
			additionalProperties: false,
		},
	},
	{
		name: 'read_state',
		description:
			'Recent output lines of one session, or of all. Status, what each session was asked and what it waits on are already in the message; call this only when the answer needs what a session actually printed.',
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
			'Send the developer’s words to a session’s Claude, as they said them. Only when the developer clearly asked for work or an answer there — on a session’s screen, only a session they named in these words; anything else is for the screen (forward). A stopped session starts by itself.',
		input_schema: {
			type: 'object',
			properties: {
				ref: REF_PROPERTY,
				text: PART_PROPERTY,
				kind: KIND_PROPERTY,
				continues: CONTINUES_PROPERTY,
				my_notes: MY_NOTES_PROPERTY,
				about_last_action: ABOUT_LAST_ACTION_PROPERTY,
				deliver: DELIVER_PROPERTY,
			},
			required: ['ref', 'kind', 'my_notes'],
			additionalProperties: false,
		},
	},
	{
		name: 'switch_view',
		description:
			"Show one session on screen, or every session (Mission Control) when ref is null, or the developer's active sessions with active true.",
		input_schema: {
			type: 'object',
			properties: {
				ref: { type: ['string', 'null'] },
				active: ACTIVE_VIEW_PROPERTY,
				skip_held: SKIP_HELD_PROPERTY,
			},
			required: ['ref'],
			additionalProperties: false,
		},
	},
	{
		name: 'go_back',
		description:
			'"Go back", "back", "previous session": return to the view the developer was on before this one; said again, it walks further back. Voice OS says where they landed. Not for "home" or Mission Control: that is switch_view with null.',
		input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
	},
	{
		name: 'play_missed',
		description:
			'"What did I miss?", "any updates?": Voice OS says the other sessions\' updates that wait for a quiet moment (the meanwhile line) now, or that nothing is new. Say nothing yourself.',
		input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
	},
	{
		name: 'activate',
		description:
			'Activate a worktree on any machine, so Voice OS runs its Claude and voice reaches it ("activate scheduler on Personal", "start checkout", "enable crew main", "activate this"); also the yes to Voice OS\'s "…isn\'t active. Activate it?". It looks the name up across every worktree, so it works for one not in Sessions. Voice OS says "Activated X. Switch there?" itself. Not for creating worktrees.',
		input_schema: {
			type: 'object',
			properties: {
				name: {
					type: ['string', 'null'],
					description:
						'The worktree as said ("scheduler work one", "crew main", "the scheduler workspace"), or null for the session on screen.',
				},
				machine: {
					type: 'string',
					description: 'The machine named with it ("on Personal"), if any.',
				},
			},
			required: ['name'],
			additionalProperties: false,
		},
	},
	{
		name: 'deactivate',
		description:
			'Deactivate a session: its Claude stops, voice no longer reaches it, and its conversation resumes when it is activated again ("deactivate this", "end session checkout", "close crew main"); also the yes to Voice OS\'s "…is working. Deactivate anyway?".',
		input_schema: {
			type: 'object',
			properties: { ref: { type: ['string', 'null'] } },
			required: ['ref'],
			additionalProperties: false,
		},
	},
	{
		name: 'list_sessions',
		description:
			'Read which machines and worktrees there are, all of them, active or not: machines ("what machines do I have?"), one machine\'s worktrees ("what\'s on Personal?"), one workspace\'s ("what worktrees does scheduler have?"), or the active ones ("what\'s active?"). Say what it returns in a few words.',
		input_schema: {
			type: 'object',
			properties: {
				machine: { type: 'string', description: 'A machine named, if any.' },
				workspace: { type: 'string', description: 'A workspace named, if any.' },
				active_only: { type: 'boolean', description: 'true for "what\'s active?".' },
			},
			required: [],
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
		name: 'queued_message',
		description:
			'Words already queued for a session, waiting behind its current work (see queued in read_state). action "now": "don\'t queue it", "I want it now", "do that first" — they cut the current work and go now; never interrupt alone for this. action "drop": "take that back", "don\'t send that", "that wasn\'t for it", "I meant that for X" (on the session that got them) — they are removed if still waiting, and a session that already got them is told to ignore them. It acts on the developer\'s last words for that session when they wait there, else on the newest queued message.',
		input_schema: {
			type: 'object',
			properties: {
				ref: REF_PROPERTY,
				action: { type: 'string', enum: ['now', 'drop'] },
			},
			required: ['ref', 'action'],
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
			'The developer flags Voice OS itself going wrong — now or again and again: its speech, routing, timing, what it said or did — for debugging later ("debug note: …", "add a debug note …", and "add a note that I get double TTS" without the word "debug"). Voice OS saves their words with a snapshot of this moment beside its log. text: what they said after the trigger, as said. Reply "Debug note saved." More words for the debug note just taken ("add this too", "like the debug note") are this tool again, with those words.',
		input_schema: {
			type: 'object',
			properties: { text: { type: 'string' } },
			required: ['text'],
			additionalProperties: false,
		},
	},
	{
		name: 'note',
		description:
			'The developer\'s own note — an idea or a reminder ("note: try a tone per session", "add a note to check the retries", "note that…"). Saved as plain text in a workspace\'s notes. Not a debug note: that is for something that went wrong — and words that add to a debug_note just taken ("add this to notes too", "like the debug note") are debug_note again, not this. More words for the note just taken ("add this too") are this tool again, with those words. text: their words after the trigger, as said. workspace: only when they name one ("note for store front: …"), else null for the one on screen. Reply "Noted."',
		input_schema: {
			type: 'object',
			properties: {
				text: { type: 'string' },
				workspace: { type: ['string', 'null'] },
			},
			required: ['text', 'workspace'],
			additionalProperties: false,
		},
	},
	{
		name: 'read_notes',
		description:
			'The developer\'s recent notes for a workspace ("what are my notes?", "read my crew notes"): read them back briefly, newest last. Only to hear them: asking to go through them, pick one, or work from them ("go through my notes and pick one") is work for the session — forward it. workspace: only when named, else null for the one on screen.',
		input_schema: {
			type: 'object',
			properties: { workspace: { type: ['string', 'null'] } },
			required: ['workspace'],
			additionalProperties: false,
		},
	},
	{
		name: 'open_doc',
		description:
			'Open a doc or artifact a session made in the developer\'s browser ("open the doc", "show me the artifact", "open the risks doc"), only one listed in that session\'s docs. Asking to see something else ("show me the kernel prompt", "show me the diff") is work for the session: forward it. ref: the session, null for the one on screen. title: words from the doc\'s title when they named one, else null for its newest doc. Changing a doc ("add a section on risks to the doc") is work for the session: forward it.',
		input_schema: {
			type: 'object',
			properties: { ref: { type: ['string', 'null'] }, title: { type: ['string', 'null'] } },
			required: ['ref', 'title'],
			additionalProperties: false,
		},
	},
	{
		name: 'hands_free',
		description:
			'Set how the developer\'s browser tab listens: push (push to talk; "turn off hands-free", "stop listening", "push to talk"), on-demand (always listening, acting only on what follows "Voice OS"; "on demand mode", "listen for Voice OS", "wake word"), hands-free (always listening; "hands-free on", "start listening"). Voice OS confirms it aloud. Never for a bare "stop" or "wait": those interrupt.',
		input_schema: {
			type: 'object',
			properties: { mode: { type: 'string', enum: ['push', 'on-demand', 'hands-free'] } },
			required: ['mode'],
			additionalProperties: false,
		},
	},
	// Listed last: placed right after ignore_words they pulled the kernel off two older cases in the
	// evals (a lapsed fix offer, "rebuild and restart"). The order is prompt: moving it means re-running them.
	{
		name: 'rename_session',
		description:
			'Give a session the name the developer calls it in Voice OS ("rename this to voice os dev", "call crew main api work", "call crew main on Personal api work": that machine\'s session); an empty name clears it and the crew name comes back. ref: the session renamed, or null for the one on screen. name: the new name as said. Only the name Voice OS shows and hears: renaming something in the work ("rename the function to parseRef") is for the session — forward it; a machine ("rename vm1 to build box") is rename_machine.',
		input_schema: {
			type: 'object',
			properties: {
				ref: { type: ['string', 'null'] },
				name: { type: 'string' },
			},
			required: ['ref', 'name'],
			additionalProperties: false,
		},
	},
];

export const FORWARD_TOOL: ToolDefinition = {
	name: 'forward',
	description:
		'Send what the developer just said to the session on screen, as they said it. Use it for anything they say to that session: instructions, questions about the code, logs or the work, replies, reactions. A stopped session starts by itself.',
	input_schema: {
		type: 'object',
		properties: {
			text: PART_PROPERTY,
			kind: KIND_PROPERTY,
			continues: CONTINUES_PROPERTY,
			my_notes: MY_NOTES_PROPERTY,
			about_last_action: ABOUT_LAST_ACTION_PROPERTY,
			deliver: DELIVER_PROPERTY,
		},
		required: ['kind', 'my_notes'],
		additionalProperties: false,
	},
};

// Offered only once other machines exist: without them, what the kernel reads stays exactly as it
// was, and machine words cannot pull a plain route astray.
export const MACHINE_TOOL_DEFINITIONS: ToolDefinition[] = [
	{
		name: 'switch_view',
		description:
			'Show one session on screen; or, with ref null, one machine\'s sessions when machine names one, else Mission Control. A session with its machine named ("crew main on my Mac") → that ref and that machine.',
		input_schema: {
			type: 'object',
			properties: {
				ref: { type: ['string', 'null'] },
				machine: {
					type: 'string',
					description:
						'A machine\'s name or id, or "this Mac": its sessions (ref null), or the session named on it.',
				},
				active: ACTIVE_VIEW_PROPERTY,
				skip_held: SKIP_HELD_PROPERTY,
			},
			required: ['ref'],
			additionalProperties: false,
		},
	},
	{
		name: 'rename_machine',
		description:
			'Give another machine the name the developer calls it ("rename vm1 to build box", "call the GPU box training rig"). Only when they clearly asked to rename a machine.',
		input_schema: {
			type: 'object',
			properties: {
				machine: { type: 'string', description: "The machine's current name or id." },
				name: { type: 'string', description: 'The new name, as the developer said it.' },
			},
			required: ['machine', 'name'],
			additionalProperties: false,
		},
	},
];

export const listToolsFor = (forwardTo: string | null, hasMachines = false): ToolDefinition[] => {
	const tools = hasMachines
		? [
				...TOOL_DEFINITIONS.filter((tool) => tool.name !== 'switch_view'),
				...MACHINE_TOOL_DEFINITIONS,
			]
		: TOOL_DEFINITIONS;

	// Offered only while a session is on screen: a tool that needs no ref is chosen reliably and fast.
	// History is left out there: that Claude holds its own, and the kernel answered from it instead of forwarding.
	return forwardTo
		? [FORWARD_TOOL, ...tools.filter((tool) => tool.name !== 'read_history')]
		: tools;
};

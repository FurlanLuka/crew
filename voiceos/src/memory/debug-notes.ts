import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { HOME_SCREEN, type State } from '../shared/protocol.js';

interface HeardLine {
	utterance: string;
	did: string[];
	reply: string;
	at: string;
}

interface SessionSnapshot {
	ref: string;
	status: string;
	queued: number;
	needsUser: string | null;
	lastAsked: string | null;
}

interface AskSnapshot {
	ref: string;
	kind: string;
}

interface SpokenSnapshot {
	source: string;
	text: string;
	at: string;
}

export interface DebugNote {
	at: string;
	// The kernel's words for what went wrong.
	text: string;
	// What the developer actually said: the kernel's text can drop what mattered.
	said: string | null;
	view: string;
	heardHere: HeardLine[];
	sessions: SessionSnapshot[];
	asks: AskSnapshot[];
	spoken: SpokenSnapshot[];
	devOffer: string | null;
}

const SPOKEN_LINES_KEPT = 5;

const toIsoString = (timestampMs: number) => new Date(timestampMs).toISOString();

export interface DebugNoteWords {
	text: string;
	said: string | null;
}

interface CreateDebugNoteParams extends DebugNoteWords {
	state: State;
	now: number;
}

export const createDebugNote = ({ state, text, said, now }: CreateDebugNoteParams): DebugNote => {
	// The log around `at` tells what happened; the note says what the developer thought was wrong.
	const view = state.view.kind === 'session' ? state.view.ref : HOME_SCREEN;

	return {
		at: toIsoString(now),
		text,
		said,
		view,
		heardHere: (state.voiceLog[view] ?? []).map((entry) => ({
			utterance: entry.utterance,
			did: entry.did,
			reply: entry.reply,
			at: toIsoString(entry.at),
		})),
		sessions: state.order.flatMap((ref) => {
			const session = state.sessions[ref];

			return session
				? [
						{
							ref,
							status: session.status,
							queued: session.queue.length,
							needsUser: session.needsUser?.text ?? null,
							lastAsked: session.requests.at(-1)?.text ?? null,
						},
					]
				: [];
		}),
		asks: state.asks.map((ask) => ({ ref: ask.ref, kind: ask.kind })),
		spoken: state.spoken
			.slice(-SPOKEN_LINES_KEPT)
			.map((line) => ({ source: line.source, text: line.text, at: toIsoString(line.at) })),
		devOffer: state.devOffer
			? `${state.devOffer.ref} (${state.devOffer.servers.join(', ')})`
			: null,
	};
};

export const saveDebugNote = (file: string, note: DebugNote): void => {
	// One JSON line per note beside the log: `jq` lists them, `at` finds the log lines around each.
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify(note)}\n`);
};

// What Voice OS asks or tells right now, as the page shows it: the moments row above the spoken line,
// the ask docked above the voice bar and the state row under a session's header. Pure: the components
// only draw what these return.
import { listHeardAsks } from '../shared/active.js';
import { isReachable, readMachineTitle, readSessionLabel } from '../shared/machines.js';
import { machineOf } from '../shared/machine-ref.js';
import type { Action, Denial, PendingAsk, SpokenLine, State } from '../shared/protocol.js';
import { countOf } from './count.js';
import { readScreenRef } from '../state/helpers.js';
import { readSendNowAction } from '../state/delivery.js';

// One answer button: the action it dispatches, or none for "not now" (the row is set aside here).
export interface MomentAnswer {
	label: string;
	action: Action | null;
	isPrimary?: true;
}

export interface Moment {
	// Stable for one moment, so a "not now" sets aside that one and not the next.
	key: string;
	text: string;
	// What to say instead of clicking.
	say: string;
	answers: MomentAnswer[];
}

// A meanwhile line stays answerable this long after it was said.
const MEANWHILE_SHOWN_MS = 60_000;

const describeSwitchOffer = (state: State): Moment | null => {
	const offer = state.switchOffer;

	if (!offer) {
		return null;
	}

	const label = readSessionLabel(state, offer.ref);
	const key = `offer-${offer.at}`;

	switch (offer.kind ?? 'switch') {
		case 'activate':
			return {
				key,
				text: `${label} isn’t active. Activate it?`,
				say: 'your words wait in its queue until you do',
				answers: [
					{ label: 'Activate', action: { type: 'activate', ref: offer.ref }, isPrimary: true },
					{ label: 'Not now', action: null },
				],
			};
		case 'send_now':
			return {
				key,
				text: `Queued for after ${label}'s current work. Send it now?`,
				say: 'say yes, or keep talking',
				answers: [
					...(offer.queuedId
						? [
								{
									label: 'Send now',
									action: readSendNowAction(state, offer.ref, offer.queuedId),
									isPrimary: true as const,
								},
							]
						: []),
					{ label: 'Keep it queued', action: null },
				],
			};
		case 'deactivate':
			return {
				key,
				text: `${label} is working. Deactivate anyway?`,
				say: 'its turn stops; the worktree stays',
				answers: [
					{ label: 'Deactivate', action: { type: 'deactivate', ref: offer.ref }, isPrimary: true },
					{ label: 'Keep it', action: null },
				],
			};
		default:
			return {
				key,
				text: `Sent to ${label}. Switch there?`,
				say: 'say yes, or keep talking',
				answers: [
					{
						label: 'Switch',
						action: { type: 'switch_view', view: { kind: 'session', ref: offer.ref } },
						isPrimary: true,
					},
					{ label: 'Stay here', action: null },
				],
			};
	}
};

const describeTargetAsk = (state: State): Moment | null => {
	const ask = state.targetAsk;

	if (!ask) {
		return null;
	}

	const label = readSessionLabel(state, ask.ref);

	return {
		key: `target-${ask.at}`,
		text: `For ${label}?`,
		say: 'you mentioned it; say yes to send it there',
		answers: [
			{
				label: `Send to ${label}`,
				action: { type: 'settle_target', at: ask.at, toTarget: true },
				isPrimary: true,
			},
			{ label: 'No, here', action: { type: 'settle_target', at: ask.at, toTarget: false } },
		],
	};
};

const findMeanwhileLine = (state: State, now: number): SpokenLine | null => {
	const line = state.spoken.at(-1);

	return line?.isUpdate && line.refs?.length && now - line.at < MEANWHILE_SHOWN_MS ? line : null;
};

const describeMeanwhile = (state: State, now: number): Moment | null => {
	const line = findMeanwhileLine(state, now);
	const screen = readScreenRef(state);

	// On the session it was about, its own stream says the same: the card would say it twice.
	if (line && (line.refs ?? []).every((ref) => ref === screen)) {
		return null;
	}

	if (line) {
		return {
			key: `meanwhile-${line.id}`,
			text: line.text,
			say: 'said once it was quiet',
			answers: (line.refs ?? [])
				.filter((ref) => state.sessions[ref])
				.map((ref, index) => ({
					label: `Go to ${readSessionLabel(state, ref)}`,
					action: { type: 'switch_view', view: { kind: 'session', ref } },
					...(index === 0 ? { isPrimary: true as const } : {}),
				})),
		};
	}

	const waiting = state.meanwhile.length;

	if (waiting === 0) {
		return null;
	}

	return {
		key: `waiting-${waiting}-${state.meanwhile[0]?.at ?? 0}`,
		text: `${countOf(waiting, 'update')} from other sessions, said once it's quiet.`,
		say: 'or say “what did I miss?”',
		answers: [{ label: 'Hear them now', action: { type: 'play_meanwhile' }, isPrimary: true }],
	};
};

// The one moment shown: a question Voice OS asked beats news about elsewhere.
export const describeMoment = (state: State, now: number): Moment | null =>
	describeTargetAsk(state) ?? describeSwitchOffer(state) ?? describeMeanwhile(state, now);

// What one session waits on, whoever draws it: Set up's chat reads its setup session's ask here.
export const readSessionAsk = (state: State, ref: string): PendingAsk | null =>
	state.asks.find((ask) => ask.ref === ref) ?? null;

// Docked above the voice bar: only the screen's session's ask (another session's waits on its own
// screen), and only one voice hears, so a setup session's ask never shows in Voice OS.
export const readScreenAsk = (state: State): PendingAsk | null => {
	const { view } = state;

	return view.kind === 'session'
		? (listHeardAsks(state).find((ask) => ask.ref === view.ref) ?? null)
		: null;
};

export type SessionState =
	| { kind: 'denial'; denial: Denial }
	| { kind: 'dropped'; machine: string; detail: string | null }
	| { kind: 'crashed'; error: string }
	| { kind: 'none' };

// The row under a session's header: what's wrong, with the way out. What it waits on is docked
// above the voice bar instead (readScreenAsk).
export const describeSessionState = (state: State, ref: string): SessionState => {
	const denial = state.denials.find((candidate) => candidate.ref === ref);

	if (denial) {
		return { kind: 'denial', denial };
	}

	const machine = machineOf(ref);

	if (machine && !isReachable(state, ref)) {
		return {
			kind: 'dropped',
			machine: readMachineTitle(state, machine),
			detail: state.machines[machine]?.detail ?? null,
		};
	}

	const session = state.sessions[ref];

	if (session?.status === 'stopped' && session.error) {
		return { kind: 'crashed', error: session.error };
	}

	return { kind: 'none' };
};

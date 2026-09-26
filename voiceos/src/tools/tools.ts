import {
	isOfferFresh,
	OFFER_TTL_MS,
	type Action,
	type PendingAsk,
	type Session,
	type State,
} from '../shared/protocol.js';
import { formatAge } from '../state/working.js';
import { buildSituationNote } from '../sessions/voice-context.js';
import { answerAsk } from './answer.js';
import type { HistoryQuery } from '../memory/journal.js';
import type { ToolName } from './definitions.js';
import { findNamedRefs, findSessionsNamedIn } from './session-naming.js';
import { describeSession, findLatestDenial } from './session-view.js';
import { type ToolResult, fail, succeed, checkRef } from './results.js';

export interface HistoryEntry {
	ts: string;
	ref: string;
	asked: string | null;
	did: string;
}

export interface ToolContext {
	getState: () => State;
	// Lets destructive calls check it named one session; a follow-up names it with the one before.
	utterance?: string;
	// Oldest first: the follow-up check, and the context a newly started session is given.
	recentUtterances?: string[];
	// Captured at routing, so a view that changes while the model thinks cannot redirect forward.
	forwardTo?: string | null;
	// The session on screen when the words were said: "end this session" names it.
	screen?: string | null;
	// Spoken, not typed: a follow-up that may interrupt the reply it follows.
	isSpoken?: boolean;
	// Pending when the words were said: never answer one that opened while the model thought.
	asks: PendingAsk[];
	// Required so a server that forgets to wire them fails to compile, not a "Noted." that saved nothing.
	mute: () => void;
	saveDebugNote: (text: string) => void;
	dispatch: (action: Action) => void;
	now: () => number;
	readHistory: (query: HistoryQuery) => HistoryEntry[];
}

interface BuildSessionNoteParams {
	session: Session;
	state: State;
	recent: string[];
}

export const buildSessionNote = ({
	session,
	state,
	recent,
}: BuildSessionNoteParams): string | undefined => {
	// A session's first message since it started carries what only Voice OS knows.
	const isFirstMessage =
		session.status === 'stopped' || (session.isFresh && session.queue.length === 0);

	if (!isFirstMessage) {
		return undefined;
	}

	return buildSituationNote({ servers: state.devServers[session.ref] ?? [], recent }) || undefined;
};

const describeBlockingAsk = (state: State, ref: string): string | null => {
	// Words sent to an open permission or plan would answer it as a "no" carrying them.
	const ask = state.asks.find((pendingAsk) => pendingAsk.ref === ref);

	if (!ask || ask.kind === 'question') {
		return null;
	}

	return `${ref} is waiting on ${ask.kind === 'permission' ? `a permission (${ask.summary})` : 'a plan approval'}: answer it with the answer tool, then send anything more.`;
};

interface SendTextParams {
	state: State;
	ref: string;
	text: string;
	toolContext: ToolContext;
}

const sendText = ({ state, ref, text, toolContext }: SendTextParams): void => {
	const session = state.sessions[ref];
	const note = session
		? buildSessionNote({ session, state, recent: toolContext.recentUtterances ?? [] })
		: undefined;
	toolContext.dispatch({
		type: 'send',
		ref,
		text,
		...(note ? { note } : {}),
		...(toolContext.isSpoken ? { isSpoken: true } : {}),
	});
};

export const executeTool = async (
	name: string,
	input: Record<string, unknown>,
	toolContext: ToolContext,
): Promise<ToolResult> => {
	const state = toolContext.getState();

	switch (name as ToolName) {
		case 'forward': {
			const target = toolContext.forwardTo;

			if (!target || !state.sessions[target]) {
				return fail('no session to forward to: use send_to with a ref');
			}

			const text = typeof input.text === 'string' ? input.text.trim() : '';

			if (!text) {
				return fail('empty text');
			}

			const blockingAsk = describeBlockingAsk(state, target);

			if (blockingAsk) {
				return fail(blockingAsk);
			}

			sendText({ state, ref: target, text, toolContext });

			return succeed(`sent to ${target}`);
		}

		case 'ignore_words': {
			return succeed('nothing done or said');
		}

		case 'read_state': {
			const now = toolContext.now();

			if (input.ref === null || input.ref === undefined) {
				return succeed(
					state.order.map((ref) => describeSession({ state, ref, isDetailed: false, now })),
				);
			}

			const checked = checkRef(state, input.ref);

			return checked.ok
				? succeed(describeSession({ state, ref: checked.ref, isDetailed: true, now }))
				: fail(checked.error);
		}

		case 'read_history': {
			const limit = Math.min(20, Math.max(1, Number(input.limit) || 5));
			const checked = typeof input.ref === 'string' ? checkRef(state, input.ref) : null;

			if (checked && !checked.ok) {
				return fail(checked.error);
			}

			const query = typeof input.query === 'string' && input.query.trim() ? input.query : null;

			return succeed(
				toolContext.readHistory({ ref: checked?.ok ? checked.ref : null, query, limit }),
			);
		}

		case 'send_to': {
			const checked = checkRef(state, input.ref);

			if (!checked.ok) {
				return fail(checked.error);
			}

			const text = typeof input.text === 'string' ? input.text.trim() : '';

			if (!text) {
				return fail('empty instruction');
			}

			const blockingAsk = describeBlockingAsk(state, checked.ref);

			if (blockingAsk) {
				return fail(blockingAsk);
			}

			sendText({ state, ref: checked.ref, text, toolContext });

			return succeed(`sent to ${checked.ref}`);
		}

		case 'switch_view': {
			if (input.ref === null || input.ref === undefined) {
				toolContext.dispatch({ type: 'switch_view', view: { kind: 'grid' } });

				return succeed('showing every session');
			}

			const checked = checkRef(state, input.ref);

			if (!checked.ok) {
				return fail(checked.error);
			}

			toolContext.dispatch({ type: 'switch_view', view: { kind: 'session', ref: checked.ref } });

			return succeed(`showing ${checked.ref}`);
		}

		case 'start_session': {
			const checked = checkRef(state, input.ref);

			if (!checked.ok) {
				return fail(checked.error);
			}

			if (state.sessions[checked.ref]?.status !== 'stopped') {
				return succeed(`${checked.ref} is already ${state.sessions[checked.ref]?.status}`);
			}

			toolContext.dispatch({ type: 'start_session', ref: checked.ref });
			// "Start X" also shows it, as it always has.
			toolContext.dispatch({ type: 'switch_view', view: { kind: 'session', ref: checked.ref } });

			return succeed(`starting ${checked.ref}`);
		}

		case 'stop_session': {
			const checked = checkRef(state, input.ref);

			if (!checked.ok) {
				return fail(checked.error);
			}

			const namedRefs = findNamedRefs(state, toolContext, checked.ref);

			if (namedRefs.length !== 1 || namedRefs[0] !== checked.ref) {
				return fail(
					`Not stopped: the developer did not name exactly one session (${namedRefs.length ? namedRefs.join(', ') : 'none'} fit). Ask which one.`,
				);
			}

			toolContext.dispatch({ type: 'stop_session', ref: checked.ref });

			return succeed(`stopped ${checked.ref}`);
		}

		case 'crew_dev': {
			const checked = checkRef(state, input.ref);

			if (!checked.ok) {
				return fail(checked.error);
			}

			const action = input.action;

			if (action === 'status') {
				return succeed({
					ref: checked.ref,
					servers: state.devServers[checked.ref] ?? [],
					starting: state.devStarting.includes(checked.ref),
				});
			}

			if (action !== 'start' && action !== 'stop' && action !== 'restart') {
				return fail('action must be start, stop, restart or status');
			}

			// The same path as the panel's buttons: Voice OS speaks the servers' verdict itself.
			toolContext.dispatch({ type: `dev_${action}`, ref: checked.ref });

			return succeed(`${action} requested for ${checked.ref}; Voice OS announces the result`);
		}

		case 'answer':
			return answerAsk({ state, input, toolContext });

		case 'interrupt': {
			const checked = checkRef(state, input.ref);

			if (!checked.ok) {
				return fail(checked.error);
			}

			const isNamed =
				toolContext.utterance === undefined ||
				checked.ref === toolContext.screen ||
				findSessionsNamedIn(state, toolContext.utterance).includes(checked.ref);

			if (!isNamed) {
				return fail(
					`Not interrupted: ${checked.ref} is neither on screen nor named. Ask which one.`,
				);
			}

			const status = state.sessions[checked.ref]?.status;

			if (status !== 'running' && status !== 'blocked') {
				return succeed(`${checked.ref} is not working on anything (${status})`);
			}

			toolContext.dispatch({ type: 'interrupt', ref: checked.ref });

			return succeed(`interrupted ${checked.ref}`);
		}

		case 'mute': {
			toolContext.mute();

			return succeed('quiet: only questions that need the developer are spoken');
		}

		case 'debug_note': {
			const text = typeof input.text === 'string' ? input.text.trim() : '';

			if (!text) {
				return fail('the note is empty: ask what to note');
			}

			toolContext.saveDebugNote(text);

			return succeed('noted with a snapshot of this moment');
		}

		case 'dev_offer': {
			const devOffer = state.devOffer;

			if (!devOffer) {
				return fail('there is no fix offer to answer');
			}

			if (input.accept !== true) {
				toolContext.dispatch({ type: 'dismiss_dev_offer' });

				return succeed('offer dismissed');
			}

			const offeredRef = devOffer.ref;

			if (!isOfferFresh(devOffer, toolContext.now())) {
				return fail(
					`the fix offer for ${offeredRef} is over ${formatAge(OFFER_TTL_MS)} old; tell the developer it lapsed`,
				);
			}

			toolContext.dispatch({ type: 'fix_dev', ref: offeredRef });

			return succeed(`fixing ${offeredRef}`);
		}

		case 'allow_denied': {
			const checked = checkRef(state, input.ref);

			if (!checked.ok) {
				return fail(checked.error);
			}

			const denial = findLatestDenial(state, checked.ref);

			if (!denial) {
				return fail(`${checked.ref} has nothing blocked`);
			}

			toolContext.dispatch({ type: 'allow_denied', denialId: denial.id });

			return succeed(`allowed ${checked.ref} once`);
		}

		default: {
			return fail(`unknown tool ${name}`);
		}
	}
};

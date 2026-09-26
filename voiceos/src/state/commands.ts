import {
	COMMAND_TTL_MS,
	type GuardedCommand,
	type Input,
	type PendingAsk,
	type Stamped,
	type State,
} from '../shared/protocol.js';
import type { ReducerResult } from './reducer.js';
import { deliverSend } from './delivery.js';
import { pushNotice, readLabel, withoutEffects } from './helpers.js';

type CommandAsk = Extract<PendingAsk, { kind: 'command' }>;
type CommandInput = Extract<Input, { type: 'answer_command' | 'command_expired' }>;

// /reset and /new are Claude Code's own aliases of /clear.
const CLEAR_PATTERN = /^\/(?:clear|reset|new)$/i;
const COMPACT_PATTERN = /^\/compact(?:\s[\s\S]*)?$/i;

export const readGuardedCommand = (text: string): GuardedCommand | null => {
	// Both throw away or rewrite what the session remembers: a misheard word must not run them.
	const trimmed = text.trim();

	if (CLEAR_PATTERN.test(trimmed)) {
		return 'clear';
	}

	return COMPACT_PATTERN.test(trimmed) ? 'compact' : null;
};

export const describeCommandAloud = (command: GuardedCommand, label: string): string => {
	return `${command === 'clear' ? 'Clear' : 'Compact'} ${label}'s context? Say yes to confirm.`;
};

export const findCommandAsk = (state: State, ref: string): CommandAsk | null => {
	const ask = state.asks.find(
		(pendingAsk) => pendingAsk.ref === ref && pendingAsk.kind === 'command',
	);

	return ask?.kind === 'command' ? ask : null;
};

interface HoldCommandParams {
	state: State;
	ref: string;
	command: GuardedCommand;
	text: string;
	stamped: Stamped;
}

export const holdCommand = ({
	state,
	ref,
	command,
	text,
	stamped,
}: HoldCommandParams): ReducerResult => {
	// One held command per session: a second one replaces the first.
	const ask: CommandAsk = { id: stamped.id, ref, at: stamped.at, kind: 'command', command, text };
	const asks = [
		...state.asks.filter((pending) => !(pending.ref === ref && pending.kind === 'command')),
		ask,
	];

	return {
		state: { ...state, asks },
		effects: [
			{
				type: 'speak',
				text: describeCommandAloud(command, readLabel(state, ref)),
				source: 'alert',
				ref,
				isAsking: true,
			},
			{ type: 'expire_command', askId: ask.id },
		],
	};
};

interface CancelCommandParams {
	state: State;
	ask: CommandAsk;
	stamped: Stamped;
	reason?: string;
}

export const cancelCommand = ({
	state,
	ask,
	stamped,
	reason = `Cancelled /${ask.command}.`,
}: CancelCommandParams): State => {
	const withoutAsk = { ...state, asks: state.asks.filter((pending) => pending.id !== ask.id) };

	return pushNotice({ state: withoutAsk, ref: ask.ref, text: reason, stamped, suffix: 'cancel' });
};

export const isCommandInput = (input: Input): input is CommandInput =>
	input.type === 'answer_command' || input.type === 'command_expired';

export const reduceCommand = (
	state: State,
	input: CommandInput,
	stamped: Stamped,
): ReducerResult => {
	const ask = state.asks.find((pending) => pending.id === input.askId);

	if (ask?.kind !== 'command') {
		return withoutEffects(state);
	}

	// Left waiting, it would keep refusing every word for that session: it lapses, and says so.
	if (input.type === 'command_expired') {
		return withoutEffects(
			cancelCommand({
				state,
				ask,
				stamped,
				reason: `The /${ask.command} went unconfirmed and was dropped.`,
			}),
		);
	}

	if (!input.isApproved) {
		return withoutEffects(cancelCommand({ state, ask, stamped }));
	}

	// The lapse arrives on a timer; a yes that beats the timer by a hair is still too late.
	if (stamped.at - ask.at > COMMAND_TTL_MS) {
		return withoutEffects(
			cancelCommand({
				state,
				ask,
				stamped,
				reason: `The /${ask.command} waited too long and was dropped: send it again.`,
			}),
		);
	}

	const withoutAsk = { ...state, asks: state.asks.filter((pending) => pending.id !== ask.id) };
	const status = withoutAsk.sessions[ask.ref]?.status;
	// Stopped or starting, it is sent as soon as the session is up: only real work makes it wait.
	const isBusy = status === 'running' || status === 'blocked';
	// Sent as typed: no note and not spoken, so it is never merged into a follow-up.
	const delivered = deliverSend({
		state: withoutAsk,
		ref: ask.ref,
		text: ask.text,
		isSpoken: false,
		stamped,
	});

	if (!isBusy) {
		return delivered;
	}

	const notice = `${ask.command === 'clear' ? 'Clears' : 'Compacts'} after its current work.`;

	return {
		state: pushNotice({
			state: delivered.state,
			ref: ask.ref,
			text: notice,
			stamped,
			suffix: 'held',
		}),
		effects: delivered.effects,
	};
};

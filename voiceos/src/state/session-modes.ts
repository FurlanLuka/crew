// A session's permission mode: picked by the developer (the chip, /mode, voice), kept per session
// until changed, and run by its worker as a Claude Code mode. Pure: modes.json is memory/modes.ts's.
import { isSetupRef } from '../shared/machine-ref.js';
import {
	canChooseMode,
	fromSdkMode,
	isSessionMode,
	MODE_LABELS,
	readMode,
	toSdkMode,
} from '../shared/modes.js';
import type {
	Input,
	PermissionSuggestion,
	SessionMode,
	SessionModeEntry,
	Stamped,
	State,
} from '../shared/protocol.js';
import type { Effect, ReducerResult } from './reducer.js';
import { isWorkerUp, pushNotice, updateSession, withoutEffects } from './helpers.js';

const MODE_INPUTS = ['set_mode', 'modes_loaded', 'mode_refused'] as const;

type ModeInput = Extract<Input, { type: (typeof MODE_INPUTS)[number] }>;

const MODE_INPUT_SET = new Set<string>(MODE_INPUTS);

export const isModeInput = (input: Input): input is ModeInput => MODE_INPUT_SET.has(input.type);

// What an approved plan returns to: the mode before Plan. A plan Claude entered by itself (the chip
// never said Plan) returns to the chip's mode.
export const modeAfterPlanApproval = (state: State, ref: string): SessionMode => {
	const entry = state.modes[ref];

	return entry?.mode === 'plan' ? (entry.beforePlan ?? 'auto') : (entry?.mode ?? 'auto');
};

// A worker is there to switch: starting (its manager keeps the mode for the start) or up.
const hasWorker = (state: State, ref: string): boolean => {
	const status = state.sessions[ref]?.status;

	return status === 'starting' || isWorkerUp(status);
};

const toEntry = (state: State, ref: string, mode: SessionMode): SessionModeEntry => {
	const current = readMode(state, ref);

	if (mode !== 'plan') {
		return { mode };
	}

	// Plan again keeps what it returns to; from another mode, that mode is it.
	const beforePlan = current === 'plan' ? state.modes[ref]?.beforePlan : current;

	return beforePlan && beforePlan !== 'auto' ? { mode, beforePlan } : { mode };
};

interface StoreModeParams {
	state: State;
	ref: string;
	mode: SessionMode;
}

// The mode as the state keeps it; ends a pending allow-once too, whose later restore would undo the
// choice. Auto is kept as no entry.
export const storeMode = ({ state, ref, mode }: StoreModeParams): State => {
	const entry = toEntry(state, ref, mode);
	const modes =
		entry.mode === 'auto'
			? Object.fromEntries(Object.entries(state.modes).filter(([moded]) => moded !== ref))
			: { ...state.modes, [ref]: entry };
	const next = { ...state, modes };

	return next.sessions[ref]?.allowOnce
		? updateSession(next, ref, (session) => ({ ...session, allowOnce: null }))
		: next;
};

// The worker switched to the session's mode, when one runs.
export const applyModeEffects = (state: State, ref: string): Effect[] =>
	hasWorker(state, ref)
		? [{ type: 'worker_set_mode', ref, mode: toSdkMode(readMode(state, ref)) }]
		: [];

const describeSet = (state: State, ref: string, mode: SessionMode): string =>
	hasWorker(state, ref)
		? `Mode: ${MODE_LABELS[mode]}.`
		: `Mode: ${MODE_LABELS[mode]}. It starts in it.`;

const setMode = (
	state: State,
	input: Extract<ModeInput, { type: 'set_mode' }>,
	stamped: Stamped,
): ReducerResult => {
	const { ref, mode } = input;

	if (!canChooseMode(state, ref)) {
		return withoutEffects(
			state.sessions[ref]
				? pushNotice({
						state,
						ref,
						text: 'Setup sessions stay in Auto.',
						stamped,
						suffix: 'mode',
					})
				: state,
		);
	}

	if (readMode(state, ref) === mode) {
		return withoutEffects(state);
	}

	const stored = storeMode({ state, ref, mode });
	const text = describeSet(stored, ref, mode);

	return {
		state: pushNotice({ state: stored, ref, text, stamped, suffix: 'mode' }),
		effects: applyModeEffects(stored, ref),
	};
};

const mergeSavedModes = (
	state: State,
	input: Extract<ModeInput, { type: 'modes_loaded' }>,
): ReducerResult => {
	// A mode picked since boot wins over the saved one for that ref; a bad entry is dropped.
	const saved = Object.fromEntries(
		Object.entries(input.modes).filter(
			([ref, entry]) =>
				state.modes[ref] === undefined &&
				!isSetupRef(ref) &&
				isSessionMode(entry.mode) &&
				entry.mode !== 'auto' &&
				(entry.beforePlan === undefined || isSessionMode(entry.beforePlan)),
		),
	);

	return withoutEffects({ ...state, modes: { ...saved, ...state.modes } });
};

const REFUSAL_REASONS: Record<Extract<ModeInput, { type: 'mode_refused' }>['reason'], string> = {
	root: 'Claude Code refuses it when it runs as root',
};

const refuseMode = (
	state: State,
	input: Extract<ModeInput, { type: 'mode_refused' }>,
	stamped: Stamped,
): ReducerResult => {
	const { ref, kept } = input;

	if (!state.sessions[ref]) {
		return withoutEffects(state);
	}

	const keptMode = fromSdkMode(kept);
	const refused = MODE_LABELS[fromSdkMode(input.mode)];
	const text = `${refused} isn't available here: ${REFUSAL_REASONS[input.reason]}. Mode: ${MODE_LABELS[keptMode]}.`;

	return withoutEffects(
		pushNotice({
			state: storeMode({ state, ref, mode: keptMode }),
			ref,
			text,
			stamped,
			suffix: 'mode',
		}),
	);
};

export const reduceSessionMode = (
	state: State,
	input: ModeInput,
	stamped: Stamped,
): ReducerResult => {
	switch (input.type) {
		case 'set_mode':
			return setMode(state, input, stamped);
		case 'modes_loaded':
			return mergeSavedModes(state, input);
		case 'mode_refused':
			return refuseMode(state, input, stamped);
	}
};

// "Allow always" never moves the mode behind the chip: a card's suggestions may hold a setMode
// (an edit card's acceptEdits), which only the developer's pick may change.
export const withoutModeChanges = (suggestions: PermissionSuggestion[]): PermissionSuggestion[] =>
	suggestions.filter((suggestion) => suggestion.type !== 'setMode');

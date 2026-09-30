import type { State } from '../shared/protocol.js';
import { toSpokenName } from '../shared/spoken.js';
import { readLabel } from '../state/helpers.js';
import { normalizeName } from '../router/refs.js';
import { toLocalRef } from '../shared/machine-ref.js';
import { isPinned } from '../state/pins.js';
import { type RefCheck, type ToolResult, checkRef, fail, succeed } from './results.js';
import type { ToolContext } from './tools.js';

interface PinSessionParams {
	state: State;
	input: Record<string, unknown>;
	toolContext: ToolContext;
	// Where a bare name lands when the developer named a machine with it ("pin crew main on build box").
	scope: (ref: string) => string;
}

// A pin outlives its session (a machine out of reach, a worktree gone): it can still be unpinned by
// the name it had, so the pinned list is searched as well as the sessions.
const findPinned = (state: State, value: string): string | undefined => {
	const spoken = normalizeName(value);

	return state.pinned.find(
		(ref) =>
			ref === value ||
			normalizeName(toLocalRef(ref)) === spoken ||
			normalizeName(readLabel(state, ref)) === spoken,
	);
};

// Unpinning prefers a pin: when the words reach a session that is not pinned, a pin they also name
// (its session gone, or answering to the same words) is the one meant.
const resolvePinTarget = (
	state: State,
	value: string,
	scope: (ref: string) => string,
	isUnpin: boolean,
): RefCheck => {
	const checked = checkRef(state, value);
	const scoped = checked.ok ? scope(checked.ref) : null;

	if (scoped && (!isUnpin || isPinned(state, scoped))) {
		return { ok: true, ref: scoped };
	}

	const pinned = findPinned(state, value);

	if (pinned) {
		return { ok: true, ref: pinned };
	}

	return scoped ? { ok: true, ref: scoped } : checked;
};

export const pinSession = ({ state, input, toolContext, scope }: PinSessionParams): ToolResult => {
	const isUnpin = input.unpin === true;
	const named = typeof input.ref === 'string' && input.ref.trim() ? input.ref : null;
	const screen = toolContext.screen ?? null;
	const target: RefCheck | null = named
		? resolvePinTarget(state, named, scope, isUnpin)
		: screen
			? { ok: true, ref: screen }
			: null;

	if (!target) {
		return fail('no session on screen: name one');
	}

	if (!target.ok) {
		return fail(target.error);
	}

	const { ref } = target;

	// Only a pin can be taken off a session that is gone; a new pin needs a session to show.
	if (!isUnpin && !state.sessions[ref]) {
		return fail(`no session "${ref}". Sessions: ${state.order.join(', ')}`);
	}

	const label = toSpokenName(readLabel(state, ref));
	const wasPinned = isPinned(state, ref);

	// Said as it is: "Unpinned" for a session that never was would tell the developer it had been.
	if (isUnpin && !wasPinned) {
		return fail(`${label} is not pinned`);
	}

	const reply = `${isUnpin ? 'Unpinned' : 'Pinned'} ${label}.`;

	// Pinning twice is a no-op, and a no-op dispatch would still wake every page.
	if (isUnpin || !wasPinned) {
		toolContext.dispatch({ type: isUnpin ? 'unpin_session' : 'pin_session', ref });
	}

	return {
		...succeed(`${isUnpin ? 'unpinned' : 'pinned'} ${ref}. Say "${reply}"`),
		reply,
		// The voice log names the session even when the model left the ref to the screen.
		recordAs: { name: 'pin_session', input: { ...input, ref } },
	};
};

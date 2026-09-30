import type { State } from '../shared/protocol.js';
import { toSpokenName } from '../shared/spoken.js';
import { readLabel } from '../state/helpers.js';
import { normalizeName } from '../router/refs.js';
import { findNamedRef, isNameTaken, toSessionName } from '../state/names.js';
import { type RefCheck, type ToolResult, checkRef, fail, succeed } from './results.js';
import type { ToolContext } from './tools.js';

interface RenameSessionParams {
	state: State;
	input: Record<string, unknown>;
	toolContext: ToolContext;
	// Where a bare name lands when the developer named a machine with it ("call crew main on Personal …").
	scope: (ref: string) => string;
}

// The crew label the session falls back to once its name is cleared.
const readCrewLabel = (state: State, ref: string): string => {
	const { [ref]: _cleared, ...names } = state.names;

	return readLabel({ ...state, names }, ref);
};

// A name outlives its session (a machine out of reach, a worktree gone): it can still be cleared or
// changed by the name itself, so the names are searched as well as the sessions.
const resolveRenameTarget = (
	state: State,
	value: string,
	scope: (ref: string) => string,
): RefCheck => {
	const checked = checkRef(state, value);

	if (checked.ok) {
		return { ok: true, ref: scope(checked.ref) };
	}

	const named = findNamedRef(state, value);

	return named ? { ok: true, ref: named } : checked;
};

// Words Voice OS acts on by themselves: a session named one of them is heard as the command.
const COMMAND_WORDS = new Set([
	'back',
	'go back',
	'switch',
	'stop',
	'wait',
	'home',
	'yes',
	'no',
	'previous',
]);

const isCommandWord = (name: string): boolean => COMMAND_WORDS.has(name.trim().toLowerCase());

export const renameSession = ({
	state,
	input,
	toolContext,
	scope,
}: RenameSessionParams): ToolResult => {
	const named = typeof input.ref === 'string' && input.ref.trim() ? input.ref : null;
	const target = named ? resolveRenameTarget(state, named, scope) : null;

	if (target && !target.ok) {
		return fail(target.error);
	}

	const ref = target ? target.ref : (toolContext.screen ?? null);

	if (!ref) {
		return fail('no session on screen: name one');
	}

	// As the reducer keeps it, so "nothing changed" compares like with like.
	const name = typeof input.name === 'string' ? toSessionName(input.name) : '';

	if (name && !normalizeName(name)) {
		return fail('that is no name: ask what to call it');
	}

	// The reducer refuses it too, silently: said here, the developer hears why nothing changed.
	if (name && isNameTaken(state, ref, name)) {
		return fail(
			`"${name}" already names ${findNamedRef(state, name)}: ask for another name, or clear that one first (rename_session ref "${name}", name "")`,
		);
	}

	// "Cleared the name" of a session that had none would claim a change that never happened.
	if (!name && state.names[ref] === undefined) {
		return fail(`${toSpokenName(readLabel(state, ref))} has no name to clear`);
	}

	const isUnchanged = (state.names[ref] ?? '') === name;
	// "Renamed api work to api work" would sound like something changed.
	const renamed = isUnchanged
		? `Already named ${name}.`
		: `Renamed ${toSpokenName(readLabel(state, ref))} to ${name}.`;
	const warning = isCommandWord(name)
		? ` Heads up: "${name}" is also something you say to Voice OS, so it may be taken that way.`
		: '';
	const reply = name
		? `${renamed}${warning}`
		: `Cleared the name of ${toSpokenName(readCrewLabel(state, ref))}.`;

	if (!isUnchanged) {
		toolContext.dispatch({ type: 'rename_session', ref, name });
	}

	return {
		...succeed(`${name ? `named ${ref} "${name}"` : `cleared the name of ${ref}`}. Say "${reply}"`),
		reply,
		// The voice log names the session even when the model left the ref to the screen.
		recordAs: { name: 'rename_session', input: { ...input, ref } },
	};
};

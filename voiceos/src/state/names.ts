import { isKnownMachineRef } from '../shared/machines.js';
import type { Input, State } from '../shared/protocol.js';
import { normalizeName } from '../router/refs.js';
import type { ReducerResult } from './reducer.js';
import { withoutEffects } from './helpers.js';

const NAME_INPUTS = ['rename_session', 'names_loaded'] as const;

type NameInput = Extract<Input, { type: (typeof NAME_INPUTS)[number] }>;

const NAME_INPUT_SET = new Set<string>(NAME_INPUTS);

export const isNameInput = (input: Input): input is NameInput => NAME_INPUT_SET.has(input.type);

// The ref already called this, as voice would hear it; null when none is.
export const findNamedRef = (state: State, name: string): string | null => {
	const wanted = normalizeName(name);

	return (
		Object.keys(state.names).find((ref) => normalizeName(state.names[ref] ?? '') === wanted) ?? null
	);
};

// A name is what voice routes by: two sessions under one name would leave "go to X" guessing.
export const isNameTaken = (state: State, ref: string, name: string): boolean => {
	const owner = findNamedRef(state, name);

	return owner !== null && owner !== ref;
};

// The page's field allows as much; voice has no field, so the reducer holds the same line.
export const MAX_NAME_LENGTH = 60;

// A name as kept: spacing folded, as the field and voice would both leave it; "" is no name.
export const toSessionName = (raw: string): string =>
	raw.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH).trim();

const withoutName = (names: Record<string, string>, ref: string): Record<string, string> =>
	Object.fromEntries(Object.entries(names).filter(([named]) => named !== ref));

export const reduceName = (state: State, input: NameInput): ReducerResult => {
	switch (input.type) {
		case 'rename_session': {
			const name = toSessionName(input.name);

			if (!name) {
				return withoutEffects(
					state.names[input.ref] === undefined
						? state
						: { ...state, names: withoutName(state.names, input.ref) },
				);
			}

			// A name only for a session crew has, or one already named: its session out of reach or gone,
			// the name is still what the developer calls it by. A name no letter or digit survives in is no name.
			if (
				(!state.sessions[input.ref] && state.names[input.ref] === undefined) ||
				!normalizeName(name) ||
				state.names[input.ref] === name ||
				isNameTaken(state, input.ref, name)
			) {
				return withoutEffects(state);
			}

			return withoutEffects({ ...state, names: { ...state.names, [input.ref]: name } });
		}

		case 'names_loaded': {
			// A name given since boot wins over the saved one for that ref; a saved name now taken, or one
			// no letter or digit survives in, is dropped.
			let names = { ...state.names };

			for (const [ref, raw] of Object.entries(input.names)) {
				const name = toSessionName(raw);
				const probe = { ...state, names };

				if (
					names[ref] === undefined &&
					normalizeName(name) &&
					isKnownMachineRef(state, ref) &&
					!isNameTaken(probe, ref, name)
				) {
					names = { ...names, [ref]: name };
				}
			}

			return withoutEffects({ ...state, names });
		}
	}
};

// Where an effect goes, and how a remote's report becomes the main's: the one place refs and ask ids
// gain or lose their machine prefix.

import { joinRef, machineOf, toLocalRef } from '../shared/machine-ref.js';
import type { Observation } from '../shared/protocol.js';
import type { Effect } from '../state/reducer.js';

const HANDS_EFFECTS = [
	'worker_start',
	'worker_send',
	'worker_stop',
	'worker_interrupt',
	'worker_set_mode',
	'resolve_ask',
	'side_answer',
] as const;

// What a session manager does; everything else (speech, narration, dev) stays with the main.
export type HandsEffect = Extract<Effect, { type: (typeof HANDS_EFFECTS)[number] }>;

const HANDS_EFFECT_SET = new Set<string>(HANDS_EFFECTS);

export const isHandsEffect = (effect: Effect): effect is HandsEffect =>
	HANDS_EFFECT_SET.has(effect.type);

export type EffectRoute =
	| { kind: 'local'; effect: HandsEffect }
	// effect: as that machine knows its sessions, the prefix taken off.
	| { kind: 'remote'; machine: string; effect: HandsEffect }
	| { kind: 'other' };

const stripEffect = (effect: HandsEffect): HandsEffect =>
	effect.type === 'resolve_ask'
		? { ...effect, ref: toLocalRef(effect.ref), askId: toLocalRef(effect.askId) }
		: { ...effect, ref: toLocalRef(effect.ref) };

export const routeEffect = (effect: Effect): EffectRoute => {
	if (!isHandsEffect(effect)) {
		return { kind: 'other' };
	}

	const machine = machineOf(effect.ref);

	return machine
		? { kind: 'remote', machine, effect: stripEffect(effect) }
		: { kind: 'local', effect };
};

// A remote's report as the main keeps it: every ref and ask id carries the machine. Which reports a
// remote may make is checked where its line is read (parseRemoteLine); null: one with no ref.
export const toMainInput = (machine: string, input: Observation): Observation | null => {
	switch (input.type) {
		case 'ask_opened':
			return {
				...input,
				ask: {
					...input.ask,
					id: joinRef(machine, input.ask.id),
					ref: joinRef(machine, input.ask.ref),
				},
			};
		case 'ask_closed':
			return { ...input, askId: joinRef(machine, input.askId) };

		default: {
			const { ref } = input as { ref?: unknown };

			return typeof ref === 'string'
				? ({ ...input, ref: joinRef(machine, ref) } as Observation)
				: null;
		}
	}
};

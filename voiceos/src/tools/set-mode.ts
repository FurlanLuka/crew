// "Switch to plan mode", "put checkout in ask mode": a session's permission mode, by voice. Skip is
// asked once ("Skip permissions for checkout?"): it runs everything unchecked, and a misheard word
// must not turn checks off.
import { isSwitchOfferFresh, type State } from '../shared/protocol.js';
import { toSpokenName } from '../shared/spoken.js';
import { readLabel, readScreenRef } from '../state/helpers.js';
import {
	canChooseMode,
	describeModeSet,
	isSessionMode,
	MODE_LABELS,
	readMode,
} from '../shared/modes.js';
import { isSetupRef } from '../shared/machine-ref.js';
import { OFFER_ASKED_NOTE } from './activate.js';
import { checkRef, fail, succeed, type ToolResult } from './results.js';
import type { ToolContext } from './tools.js';

interface SetModeParams {
	state: State;
	input: Record<string, unknown>;
	toolContext: ToolContext;
}

export const setSessionMode = ({ state, input, toolContext }: SetModeParams): ToolResult => {
	const { mode } = input;

	if (!isSessionMode(mode)) {
		return fail('mode must be auto, plan, ask or skip');
	}

	const named = typeof input.ref === 'string' && input.ref.trim() ? input.ref : null;
	const screen = readScreenRef(state);

	if (!named && !screen) {
		return fail('no session on screen: ask which session, in a few words');
	}

	// Crew's own setup sessions are never active, so never found below: said here.
	if (named && isSetupRef(named.trim())) {
		return { ...succeed(`${named} is a setup session`), reply: 'Setup sessions stay in Auto.' };
	}

	const checked = named ? checkRef(state, named) : { ok: true as const, ref: screen ?? '' };
	// A mode needs no running Claude: an inactive session starts in it when activated.
	const ref = checked.ok ? checked.ref : checked.inactive;

	if (!ref) {
		return checked.ok ? fail('no session') : fail(checked.error);
	}

	const recordAs = { name: 'set_mode', input: { ref, mode } };
	const label = toSpokenName(readLabel(state, ref));
	const name = MODE_LABELS[mode];

	if (!canChooseMode(state, ref)) {
		return {
			...succeed(`${ref} is a setup session`),
			reply: 'Setup sessions stay in Auto.',
			recordAs,
		};
	}

	if (readMode(state, ref) === mode) {
		return {
			...succeed(`${ref} is already in ${mode}`),
			reply: `${label} is already in ${name}.`,
			recordAs,
		};
	}

	const offer = state.switchOffer;
	const saidAt = toolContext.heardFrom ?? toolContext.now();
	const isConfirmed =
		isSwitchOfferFresh(offer, saidAt) && offer.kind === 'skip_mode' && offer.ref === ref;

	if (mode === 'skip' && !isConfirmed) {
		toolContext.dispatch({ type: 'offer_switch', ref, kind: 'skip_mode' });

		return {
			note: OFFER_ASKED_NOTE,
			recordAs,
			...fail(`Not set yet: Voice OS asked "Skip permissions for ${label}?" itself: say nothing.`),
			isFinal: true,
		};
	}

	toolContext.dispatch({ type: 'set_mode', ref, mode, by: 'voice' });

	return {
		...succeed(`${ref} is in ${mode} mode; Voice OS said so: say nothing`),
		reply: describeModeSet(mode, ref === screen ? null : label),
		recordAs,
	};
};

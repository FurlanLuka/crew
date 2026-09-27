import type { State } from '../../shared/protocol.js';
import { findCurrentAsk } from '../../shared/route-chip.js';
import { readLabel } from '../../state/helpers.js';
import type { Dispatch } from '../types.js';
import { AskDock } from './AskDock.js';
import { DenialStrip } from './DenialStrip.js';
import { NeedsYouStrip } from './NeedsYouStrip.js';

interface DockProps {
	state: State;
	dispatch: Dispatch;
}

export const Dock = ({ state, dispatch }: DockProps) => {
	// Docked above the input bar, not a takeover: the stream stays readable while deciding.
	const ask = findCurrentAsk(state);
	const viewedSession = state.view.kind === 'session' ? state.sessions[state.view.ref] : undefined;
	const denial = state.denials.find(
		(candidate) => !viewedSession || candidate.ref === viewedSession.ref,
	);

	if (ask) {
		return <AskDock ask={ask} label={readLabel(state, ask.ref)} dispatch={dispatch} />;
	}

	if (denial) {
		return <DenialStrip denial={denial} label={readLabel(state, denial.ref)} dispatch={dispatch} />;
	}

	if (viewedSession?.needsUser) {
		return <NeedsYouStrip session={viewedSession} dispatch={dispatch} />;
	}

	return <div />;
};

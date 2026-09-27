import type { State } from '../../shared/protocol.js';
import type { Dispatch } from '../types.js';
import { Cockpit } from './Cockpit.js';
import { Grid } from './Grid.js';

interface MainProps {
	state: State;
	dispatch: Dispatch;
}

export const Main = ({ state, dispatch }: MainProps) => {
	const viewedSession = state.view.kind === 'session' ? state.sessions[state.view.ref] : undefined;

	return viewedSession ? (
		<Cockpit session={viewedSession} state={state} dispatch={dispatch} />
	) : (
		<Grid state={state} dispatch={dispatch} />
	);
};

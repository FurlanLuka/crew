import type { State } from '../../shared/protocol.js';
import type { Dispatch } from '../types.js';
import { Cockpit } from './Cockpit.js';
import { Grid } from './Grid.js';
import { Machines } from './Machines.js';

interface MainProps {
	state: State;
	dispatch: Dispatch;
}

export const Main = ({ state, dispatch }: MainProps) => {
	const viewedSession = state.view.kind === 'session' ? state.sessions[state.view.ref] : undefined;

	if (viewedSession) {
		return (
			<Cockpit
				// One per session: what was open on one (a sub-agent's transcript) stays with it.
				key={viewedSession.ref}
				session={viewedSession}
				state={state}
				dispatch={dispatch}
			/>
		);
	}

	if (state.view.kind === 'machines') {
		return <Machines state={state} dispatch={dispatch} />;
	}

	if (state.view.kind === 'active') {
		return <Grid state={state} dispatch={dispatch} isActiveView />;
	}

	return (
		<Grid
			state={state}
			dispatch={dispatch}
			{...(state.view.kind === 'grid' && state.view.machine ? { machine: state.view.machine } : {})}
		/>
	);
};

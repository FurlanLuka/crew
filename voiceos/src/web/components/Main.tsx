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
		return <Cockpit session={viewedSession} state={state} dispatch={dispatch} />;
	}

	if (state.view.kind === 'machines') {
		return <Machines state={state} dispatch={dispatch} />;
	}

	if (state.view.kind === 'pinned') {
		return <Grid state={state} dispatch={dispatch} isPinned />;
	}

	return (
		<Grid
			state={state}
			dispatch={dispatch}
			{...(state.view.kind === 'grid' && state.view.machine ? { machine: state.view.machine } : {})}
		/>
	);
};

import type { State } from '../../shared/protocol.js';
import { countSessions } from '../derive.js';
import type { Dispatch } from '../types.js';

interface TopBarProps {
	state: State;
	dispatch: Dispatch;
}

export const TopBar = ({ state, dispatch }: TopBarProps) => {
	const counts = countSessions(state);
	const viewedSession = state.view.kind === 'session' ? state.sessions[state.view.ref] : null;
	const { sevenDay, fiveHour } = state.limits;

	return (
		<header className="topbar">
			<span className="brand">
				voice<b>·</b>os
			</span>
			<span className="ws">{viewedSession ? viewedSession.label : 'all sessions'}</span>
			<span>{counts.total} sessions</span>
			{counts.running > 0 && <span className="c-amber">{counts.running} running</span>}
			{counts.waiting > 0 && <span className="c-crit">{counts.waiting} waiting on you</span>}
			<span className="sp">
				{sevenDay !== null && `weekly ${sevenDay}%`}
				{fiveHour !== null && ` · 5h ${fiveHour}%`}
			</span>
			{viewedSession && (
				<button
					type="button"
					className="home"
					onClick={() => dispatch({ type: 'switch_view', view: { kind: 'grid' } })}
				>
					Esc → Mission Control
				</button>
			)}
		</header>
	);
};

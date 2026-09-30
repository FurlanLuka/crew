import type { State } from '../../shared/protocol.js';
import {
	describeSessionBadge,
	labelAcrossMachines,
	listTabRefs,
	readLabelMachine,
	readRefTitle,
} from '../derive.js';
import type { Dispatch } from '../types.js';

interface TabsProps {
	state: State;
	dispatch: Dispatch;
}

export const Tabs = ({ state, dispatch }: TabsProps) => {
	const currentRef = state.view.kind === 'session' ? state.view.ref : null;
	const here = readLabelMachine(state);

	return (
		<nav className="tabs">
			{listTabRefs(state).map((ref) => {
				const session = state.sessions[ref];

				if (!session) {
					return null;
				}

				const badge = describeSessionBadge(session, state.asks);

				// A pinned target opens inside Pinned: the reducer adds from, whichever tab is clicked.
				return (
					<button
						type="button"
						key={ref}
						className={`tab ${ref === currentRef ? 'on' : ''} ${badge.isAlarm ? 'alarm' : ''}`}
						title={readRefTitle(state, ref)}
						onClick={() => dispatch({ type: 'switch_view', view: { kind: 'session', ref } })}
					>
						<i className={`dot ${badge.dot}`} /> {labelAcrossMachines(state, session.ref, here)}{' '}
						<span className="act">{badge.label}</span>
					</button>
				);
			})}
		</nav>
	);
};

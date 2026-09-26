import type { State } from '../../shared/protocol.js';
import { describeSessionBadge } from '../derive.js';
import type { Dispatch } from '../types.js';

interface TabsProps {
	state: State;
	dispatch: Dispatch;
}

export const Tabs = ({ state, dispatch }: TabsProps) => {
	const currentRef = state.view.kind === 'session' ? state.view.ref : null;

	return (
		<nav className="tabs">
			{state.order.map((ref) => {
				const session = state.sessions[ref];

				if (!session) {
					return null;
				}

				const badge = describeSessionBadge(session, state.asks);

				return (
					<button
						type="button"
						key={ref}
						className={`tab ${ref === currentRef ? 'on' : ''} ${badge.isAlarm ? 'alarm' : ''}`}
						onClick={() => dispatch({ type: 'switch_view', view: { kind: 'session', ref } })}
					>
						<i className={`dot ${badge.dot}`} /> {session.label}{' '}
						<span className="act">{badge.label}</span>
					</button>
				);
			})}
		</nav>
	);
};

import type { State } from '../../shared/protocol.js';
import { describeSessionBadge, labelAcrossMachines } from '../derive.js';
import { currentMachine } from '../../shared/machines.js';
import { readMachine } from '../../shared/machine-ref.js';
import type { Dispatch } from '../types.js';

interface TabsProps {
	state: State;
	dispatch: Dispatch;
}

export const Tabs = ({ state, dispatch }: TabsProps) => {
	const currentRef = state.view.kind === 'session' ? state.view.ref : null;
	// Inside a machine its tabs are its sessions; another machine is a switch on Mission Control.
	const machine = currentMachine(state);
	const refs = machine ? state.order.filter((ref) => readMachine(ref) === machine) : state.order;

	return (
		<nav className="tabs">
			{refs.map((ref) => {
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
						<i className={`dot ${badge.dot}`} />{' '}
						{labelAcrossMachines(state, session.ref, currentMachine(state))}{' '}
						<span className="act">{badge.label}</span>
					</button>
				);
			})}
		</nav>
	);
};

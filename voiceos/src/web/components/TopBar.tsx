import type { State } from '../../shared/protocol.js';
import {
	currentMachine,
	hasMachines,
	parentView,
	readMachineTitle,
} from '../../shared/machines.js';
import { countSessions } from '../derive.js';
import type { Dispatch } from '../types.js';

interface TopBarProps {
	state: State;
	dispatch: Dispatch;
}

export const TopBar = ({ state, dispatch }: TopBarProps) => {
	const machine = currentMachine(state) ?? undefined;
	const counts = countSessions(state, machine);
	const viewedSession = state.view.kind === 'session' ? state.sessions[state.view.ref] : null;
	const { sevenDay, fiveHour } = state.limits;
	const withMachines = hasMachines(state);
	const isHome =
		state.view.kind === 'machines' || (state.view.kind === 'grid' && !state.view.machine);
	const up = parentView(state);
	const upLabel =
		up.kind === 'grid' && up.machine ? readMachineTitle(state, up.machine) : 'Mission Control';
	// With other machines, the usage shown is this Mac's own Claude login.
	const limitsOwner = withMachines ? 'this Mac: ' : '';

	return (
		<header className="topbar">
			<span className="brand">
				voice<b>·</b>os
			</span>
			<span className="ws">
				{!isHome && (
					<>
						<button
							type="button"
							className="crumb"
							onClick={() => dispatch({ type: 'switch_view', view: { kind: 'machines' } })}
						>
							Mission Control
						</button>
						{' › '}
						{machine && (viewedSession || state.view.kind === 'grid') && (
							<button
								type="button"
								className="crumb"
								onClick={() => dispatch({ type: 'switch_view', view: { kind: 'grid', machine } })}
							>
								{readMachineTitle(state, machine)}
							</button>
						)}
						{viewedSession && ' › '}
					</>
				)}
				{viewedSession ? viewedSession.label : isHome ? 'Mission Control' : ''}
			</span>
			<span>{counts.total} sessions</span>
			{counts.running > 0 && <span className="c-amber">{counts.running} running</span>}
			{counts.waiting > 0 && <span className="c-crit">{counts.waiting} waiting on you</span>}
			<span className="sp">
				{sevenDay !== null && `${limitsOwner}weekly ${sevenDay}%`}
				{fiveHour !== null && ` · 5h ${fiveHour}%`}
			</span>
			{!isHome && (
				<button
					type="button"
					className="home"
					onClick={() => dispatch({ type: 'switch_view', view: up })}
				>
					Esc → {upLabel}
				</button>
			)}
		</header>
	);
};

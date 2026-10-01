import { useState } from 'react';
import type { State } from '../../shared/protocol.js';
import {
	currentMachine,
	hasMachines,
	parentView,
	readMachineTitle,
	readSessionLabel,
} from '../../shared/machines.js';
import {
	countPinned,
	countSessions,
	countUpdates,
	isInsidePinned,
	readRefTitle,
} from '../derive.js';
import type { Dispatch } from '../types.js';
import { RenameButton, RenameSession } from './RenameSession.js';
import { PinButton } from './Tile.js';

interface TopBarProps {
	state: State;
	dispatch: Dispatch;
}

const readUpLabel = (state: State): string => {
	const up = parentView(state);

	if (up.kind === 'pinned') {
		return 'Pinned';
	}

	return up.kind === 'grid' && up.machine ? readMachineTitle(state, up.machine) : 'Mission Control';
};

export const TopBar = ({ state, dispatch }: TopBarProps) => {
	const [renaming, setRenaming] = useState<string | null>(null);
	const machine = currentMachine(state) ?? undefined;
	const isPinnedView = isInsidePinned(state.view);
	// Inside Pinned the counts follow the pins, as the tabs do.
	const counts = isPinnedView ? countPinned(state) : countSessions(state, machine);
	const updates = countUpdates(state, isPinnedView ? 'pinned' : { machine });
	const viewedSession = state.view.kind === 'session' ? state.sessions[state.view.ref] : null;
	const { sevenDay, fiveHour } = state.limits;
	const withMachines = hasMachines(state);
	const isHome =
		state.view.kind === 'machines' || (state.view.kind === 'grid' && !state.view.machine);
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
						{isPinnedView ? (
							<button
								type="button"
								className="crumb"
								onClick={() => dispatch({ type: 'switch_view', view: { kind: 'pinned' } })}
							>
								Pinned
							</button>
						) : (
							machine &&
							(viewedSession || state.view.kind === 'grid') && (
								<button
									type="button"
									className="crumb"
									onClick={() => dispatch({ type: 'switch_view', view: { kind: 'grid', machine } })}
								>
									{readMachineTitle(state, machine)}
								</button>
							)
						)}
						{viewedSession && ' › '}
					</>
				)}
				{viewedSession ? (
					// Keyed by ref: a switch while the field is open never renames the next session.
					renaming === viewedSession.ref ? (
						<RenameSession
							sessionRef={viewedSession.ref}
							current={readSessionLabel(state, viewedSession.ref)}
							dispatch={dispatch}
							onDone={() => setRenaming(null)}
						/>
					) : (
						<span title={readRefTitle(state, viewedSession.ref)}>
							{readSessionLabel(state, viewedSession.ref)}
						</span>
					)
				) : isHome ? (
					'Mission Control'
				) : (
					''
				)}
			</span>
			{viewedSession && (
				<>
					<RenameButton onClick={() => setRenaming(viewedSession.ref)} />
					<PinButton
						sessionRef={viewedSession.ref}
						isPinned={state.pinned.includes(viewedSession.ref)}
						dispatch={dispatch}
					/>
				</>
			)}
			<span>
				{counts.total} {counts.total === 1 ? 'session' : 'sessions'}
			</span>
			{counts.running > 0 && <span className="c-amber">{counts.running} running</span>}
			{counts.waiting > 0 && <span className="c-crit">{counts.waiting} waiting on you</span>}
			{updates > 0 && (
				<button
					type="button"
					className="updates-waiting"
					title="Other sessions' updates, said together at the next quiet moment. Click to hear them now."
					onClick={() => dispatch({ type: 'play_meanwhile' })}
				>
					{updates} {updates === 1 ? 'update' : 'updates'} waiting
				</button>
			)}
			<span className="sp">
				{sevenDay !== null && `${limitsOwner}weekly ${sevenDay}%`}
				{fiveHour !== null && ` · 5h ${fiveHour}%`}
			</span>
			{!isHome && (
				<button
					type="button"
					className="home"
					onClick={() => dispatch({ type: 'switch_view', view: parentView(state) })}
				>
					Esc → {readUpLabel(state)}
				</button>
			)}
		</header>
	);
};

import { useState } from 'react';
import { isActive } from '../../shared/active.js';
import { SETUP_REF } from '../../shared/machine-ref.js';
import type { Session, State } from '../../shared/protocol.js';
import { readSessionLabel } from '../../shared/machines.js';
import { readWorkLabel } from '../../shared/work-label.js';
import {
	describeSessionBadge,
	labelAcrossMachines,
	readLabelMachine,
	readLastLine,
	readRefTitle,
} from '../derive.js';
import type { Dispatch } from '../types.js';
import { DevBadge } from './DevBadge.js';
import { RenameButton, RenameSession } from './RenameSession.js';

interface TileProps {
	session: Session;
	state: State;
	dispatch: Dispatch;
}

interface ActiveButtonProps {
	sessionRef: string;
	isActive: boolean;
	dispatch: Dispatch;
}

// This Mac's setup session is always active: nothing to toggle, so no button.
export const ActiveButton = ({ sessionRef, isActive: isOn, dispatch }: ActiveButtonProps) =>
	sessionRef === SETUP_REF ? null : (
		<button
			type="button"
			className="btn small toggle-active"
			onClick={() => dispatch({ type: isOn ? 'deactivate' : 'activate', ref: sessionRef })}
		>
			{isOn ? 'deactivate' : 'activate'}
		</button>
	);

export const Tile = ({ session, state, dispatch }: TileProps) => {
	const [isRenaming, setIsRenaming] = useState(false);
	const badge = describeSessionBadge(session, state.asks);
	const isOn = isActive(state, session.ref);
	const tileKind = badge.isAlarm
		? 'alarm'
		: session.isPinned
			? 'setup'
			: state.focus === session.ref
				? 'focus'
				: '';

	const handleOpen = () => {
		// Opening only looks: browsing must never spin up a Claude in a real worktree. An active
		// session opens inside Active wherever it is clicked: the reducer decides that.
		dispatch({ type: 'switch_view', view: { kind: 'session', ref: session.ref } });
	};

	// Two buttons side by side, never one inside the other: activating must not also open the session.
	// An inactive tile is dimmed: browsable, but voice neither sees nor drives it.
	return (
		<div className={`tile ${tileKind} ${isOn ? '' : 'inactive'}`} data-ref={session.ref}>
			<div className="tile-head">
				<i className={`dot ${badge.dot}`} />
				{isRenaming ? (
					<RenameSession
						sessionRef={session.ref}
						current={readSessionLabel(state, session.ref)}
						dispatch={dispatch}
						onDone={() => setIsRenaming(false)}
					/>
				) : (
					<button
						type="button"
						className="ref"
						title={readRefTitle(state, session.ref)}
						onClick={handleOpen}
					>
						{labelAcrossMachines(state, session.ref, readLabelMachine(state))}
					</button>
				)}
				<span className={`st ${badge.isAlarm ? 'c-crit' : ''}`}>{badge.label}</span>
				<RenameButton onClick={() => setIsRenaming(true)} />
				<ActiveButton sessionRef={session.ref} isActive={isOn} dispatch={dispatch} />
			</div>
			<button type="button" className="tile-open" onClick={handleOpen}>
				<span className="work">
					{readWorkLabel(session) ??
						(session.isPinned ? 'crew setup and housekeeping' : 'Nothing asked yet')}
				</span>
				<span className="br">
					{session.branch || session.cwd}
					<DevBadge
						servers={state.devServers[session.ref]}
						isStarting={state.devStarting.includes(session.ref)}
					/>
				</span>
				<span className={`body ${badge.isAlarm ? 'c-crit' : ''}`}>
					{session.needsUser?.text ?? readLastLine(session, readSessionLabel(state, session.ref))}
				</span>
			</button>
		</div>
	);
};

interface MissingTileProps {
	sessionRef: string;
	text: string;
	// The developer's name for it, if any: the one thing besides the active set that can still change.
	name: string | undefined;
	dispatch: Dispatch;
}

// An active ref whose session is not here: nothing to open, only a way to deactivate it or clear its
// name, which would otherwise keep that name from any other session.
export const MissingTile = ({ sessionRef, text, name, dispatch }: MissingTileProps) => {
	const [isRenaming, setIsRenaming] = useState(false);

	return (
		<div className="tile missing" data-ref={sessionRef}>
			<div className="tile-head">
				<i className="dot stopped" />
				{isRenaming && name !== undefined ? (
					<RenameSession
						sessionRef={sessionRef}
						current={name}
						dispatch={dispatch}
						onDone={() => setIsRenaming(false)}
					/>
				) : (
					<span className="ref" title={sessionRef}>
						{text}
					</span>
				)}
				{name !== undefined && <RenameButton onClick={() => setIsRenaming(true)} />}
				<ActiveButton sessionRef={sessionRef} isActive dispatch={dispatch} />
			</div>
		</div>
	);
};

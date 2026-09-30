import { useState } from 'react';
import type { Session, State } from '../../shared/protocol.js';
import { readSessionLabel } from '../../shared/machines.js';
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

interface PinButtonProps {
	sessionRef: string;
	isPinned: boolean;
	dispatch: Dispatch;
}

export const PinButton = ({ sessionRef, isPinned, dispatch }: PinButtonProps) => (
	<button
		type="button"
		className="btn small pin"
		onClick={() => dispatch({ type: isPinned ? 'unpin_session' : 'pin_session', ref: sessionRef })}
	>
		{isPinned ? 'unpin' : 'pin'}
	</button>
);

export const Tile = ({ session, state, dispatch }: TileProps) => {
	const [isRenaming, setIsRenaming] = useState(false);
	const badge = describeSessionBadge(session, state.asks);
	const tileKind = badge.isAlarm
		? 'alarm'
		: session.isPinned
			? 'setup'
			: state.focus === session.ref
				? 'focus'
				: '';

	const handleOpen = () => {
		// Opening only looks: browsing must never spin up a Claude in a real worktree. A pinned
		// session opens inside Pinned wherever it is clicked: the reducer decides that.
		dispatch({ type: 'switch_view', view: { kind: 'session', ref: session.ref } });
	};

	// Two buttons side by side, never one inside the other: the pin must not also open the session.
	return (
		<div className={`tile ${tileKind}`} data-ref={session.ref}>
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
				<PinButton
					sessionRef={session.ref}
					isPinned={state.pinned.includes(session.ref)}
					dispatch={dispatch}
				/>
			</div>
			<button type="button" className="tile-open" onClick={handleOpen}>
				<span className="topic">
					{session.topic ?? (session.isPinned ? 'crew setup and housekeeping' : 'No topic yet')}
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
	// The developer's name for it, if any: the one thing besides the pin that can still be changed.
	name: string | undefined;
	dispatch: Dispatch;
}

// A pin whose session is not here: nothing to open, only a way to let it go or clear its name, which
// would otherwise keep that name from any other session.
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
				<PinButton sessionRef={sessionRef} isPinned dispatch={dispatch} />
			</div>
		</div>
	);
};

import type { Session, State } from '../../shared/protocol.js';
import { describeSessionBadge, readLastLine } from '../derive.js';
import type { Dispatch } from '../types.js';
import { DevBadge } from './DevBadge.js';

interface TileProps {
	session: Session;
	state: State;
	dispatch: Dispatch;
}

export const Tile = ({ session, state, dispatch }: TileProps) => {
	const badge = describeSessionBadge(session, state.asks);
	const tileKind = badge.isAlarm
		? 'alarm'
		: session.isPinned
			? 'setup'
			: state.focus === session.ref
				? 'focus'
				: '';

	const handleOpen = () => {
		// Opening only looks: browsing must never spin up a Claude in a real worktree.
		dispatch({ type: 'switch_view', view: { kind: 'session', ref: session.ref } });
	};

	return (
		<button
			type="button"
			className={`tile ${tileKind}`}
			data-ref={session.ref}
			onClick={handleOpen}
		>
			<div className="tile-head">
				<i className={`dot ${badge.dot}`} />
				<span className="ref">{session.label}</span>
				<span className={`st ${badge.isAlarm ? 'c-crit' : ''}`}>{badge.label}</span>
			</div>
			<div className="topic">
				{session.topic ?? (session.isPinned ? 'crew setup and housekeeping' : 'No topic yet')}
			</div>
			<div className="br">
				{session.branch || session.cwd}
				<DevBadge
					servers={state.devServers[session.ref]}
					isStarting={state.devStarting.includes(session.ref)}
				/>
			</div>
			<div className={`body ${badge.isAlarm ? 'c-crit' : ''}`}>
				{session.needsUser?.text ?? readLastLine(session)}
			</div>
		</button>
	);
};

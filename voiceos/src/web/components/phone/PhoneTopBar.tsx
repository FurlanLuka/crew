// The phone's top bar. Home: crew's mark, New and the gear. A session: back, its name with its state
// dot and where it runs, and ⋯ for everything the desktop keeps beside the stream. Any other screen
// (Settings, a machine's page): back and its title.
import { readMachineTitle, readSessionLabel } from '../../../shared/machines.js';
import type { Session, State } from '../../../shared/protocol.js';
import { describeSessionBadge, describeSessionMeta } from '../../derive.js';
import type { Dispatch } from '../../types.js';
import { useNow } from '../../use-now.js';
import { GearIcon } from '../GearIcon.js';
import { NewMenu } from '../NewMenu.js';
import { BackIcon, DotsIcon } from './phone-icons.js';

interface PhoneTopBarProps {
	state: State;
	dispatch: Dispatch;
	onNewSession: () => void;
	onMore: () => void;
}

const goHome = (dispatch: Dispatch) => () =>
	dispatch({ type: 'switch_view', view: { kind: 'active' } });

const BackButton = ({ dispatch }: { dispatch: Dispatch }) => (
	<button type="button" className="ic" aria-label="Back to Home" onClick={goHome(dispatch)}>
		<BackIcon />
	</button>
);

interface SessionTitleProps {
	state: State;
	session: Session;
}

export const SessionTitle = ({ state, session }: SessionTitleProps) => {
	const now = useNow();
	const badge = describeSessionBadge(session, state.asks);

	return (
		<div className="ttl">
			<b>
				<i className={`dot ${badge.dot}`} aria-hidden="true" />
				<span>{readSessionLabel(state, session.ref)}</span>
			</b>
			<span className="m">{describeSessionMeta(state, session, now)}</span>
		</div>
	);
};

const readScreenTitle = (state: State): string => {
	const { view } = state;

	if (view.kind === 'settings') {
		return 'Settings';
	}

	return view.kind === 'activate' && view.machine
		? readMachineTitle(state, view.machine)
		: 'Sessions';
};

export const PhoneTopBar = ({ state, dispatch, onNewSession, onMore }: PhoneTopBarProps) => {
	const { view } = state;
	const session = view.kind === 'session' ? state.sessions[view.ref] : undefined;

	if (session) {
		return (
			<header className="mtop">
				<BackButton dispatch={dispatch} />
				<SessionTitle state={state} session={session} />
				<button type="button" className="ic fill" aria-label="More" onClick={onMore}>
					<DotsIcon />
				</button>
			</header>
		);
	}

	if (view.kind === 'active') {
		return (
			<header className="mtop home">
				<span className="mbrand">
					crew<span>Voice OS</span>
				</span>
				<span className="acts">
					<NewMenu state={state} dispatch={dispatch} onNewSession={onNewSession} />
					<button
						type="button"
						className="ic"
						aria-label="Settings"
						onClick={() => dispatch({ type: 'switch_view', view: { kind: 'settings' } })}
					>
						<GearIcon size={18} />
					</button>
				</span>
			</header>
		);
	}

	return (
		<header className="mtop">
			<BackButton dispatch={dispatch} />
			<div className="ttl">
				<b>
					<span>{readScreenTitle(state)}</span>
				</b>
			</div>
			<span />
		</header>
	);
};

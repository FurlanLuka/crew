// A session on a phone: only its conversation. What it waits on (a question, a permission, a call
// auto mode blocked) is the last thing in the history, not part of the bar; ⋯ opens PhoneMore.
import type { ClientMessage, Session, State } from '../../../shared/protocol.js';
import { readLabel } from '../../../state/helpers.js';
import { isActive } from '../../../shared/active.js';
import { readScreenAsk, readScreenDenial } from '../../moments.js';
import type { Dispatch } from '../../types.js';
import { AskDock } from '../AskDock.js';
import { StoppedNote } from '../Cockpit.js';
import { DenialSheet } from '../DenialSheet.js';
import { useSessionDialogs } from '../SessionPanels.js';
import { SessionStateRow } from '../SessionStateRow.js';
import { SessionStream } from '../SessionStream.js';
import { PhoneMore } from './PhoneMore.js';

interface PhoneSessionProps {
	session: Session;
	state: State;
	dispatch: Dispatch;
	send: (message: ClientMessage) => void;
	isMoreOpen: boolean;
	onCloseMore: () => void;
}

export const PhoneSession = ({
	session,
	state,
	dispatch,
	send,
	isMoreOpen,
	onCloseMore,
}: PhoneSessionProps) => {
	const dialogs = useSessionDialogs(session, state);
	const ask = readScreenAsk(state);
	const denial = readScreenDenial(state);

	return (
		<section className="vo-view vo-session" aria-label="session">
			<SessionStateRow state={state} sessionRef={session.ref} dispatch={dispatch} />
			<SessionStream
				sessionRef={session.ref}
				session={session}
				className="vo-stream stream"
				hasAsk={state.asks.some((pending) => pending.ref === session.ref)}
				openFor={dialogs.openFor}
				peerRunFor={dialogs.peerRunFor}
			>
				<StoppedNote session={session} isOn={isActive(state, session.ref)} />
				{denial && (
					<DenialSheet denial={denial} label={readLabel(state, denial.ref)} dispatch={dispatch} />
				)}
				{ask && <AskDock ask={ask} label={readLabel(state, ask.ref)} dispatch={dispatch} />}
			</SessionStream>
			{isMoreOpen && (
				<PhoneMore
					session={session}
					state={state}
					dispatch={dispatch}
					send={send}
					dialogs={dialogs}
					onClose={onCloseMore}
				/>
			)}
			{dialogs.dialogs}
		</section>
	);
};

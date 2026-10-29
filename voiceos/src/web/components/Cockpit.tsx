// A session, full width: its header, the state row, then the stream and the side panels. On a
// desktop only the stream scrolls; the header, the panels and the voice bar stay put.
import { useState } from 'react';
import { isActive } from '../../shared/active.js';
import { readMachine, toLocalRef } from '../../shared/machine-ref.js';
import { readSessionLabel } from '../../shared/machines.js';
import type { Session, State } from '../../shared/protocol.js';
import { describeSessionBadge, describeSessionMeta, readRefTitle } from '../derive.js';
import { isOk, readCrewLine, runCrew } from '../setup/api.js';
import type { Dispatch } from '../types.js';
import { useNow } from '../use-now.js';
import { RenameSession } from './RenameSession.js';
import { SessionPanels, useSessionDialogs } from './SessionPanels.js';
import { SessionStateRow } from './SessionStateRow.js';
import { SessionStream } from './SessionStream.js';

interface CockpitProps {
	session: Session;
	state: State;
	dispatch: Dispatch;
}

// Where a Remove stands: the confirm shown, crew running, or crew's reason it was not removed.
export type Removal =
	| { kind: 'asking' }
	| { kind: 'removing' }
	| { kind: 'failed'; line: string }
	| null;

interface RemoveChatProps {
	session: Session;
	dispatch: Dispatch;
	state: Removal;
	onState: (state: Removal) => void;
}

// A plain session goes: its Claude stops, crew drops its record; the folder and the conversation's
// files stay where they are.
export const RemoveChat = ({ session, dispatch, state, onState }: RemoveChatProps) => {
	const remove = async () => {
		onState({ kind: 'removing' });
		dispatch({ type: 'deactivate', ref: session.ref });
		const reply = await runCrew(readMachine(session.ref), {
			type: 'chat_rm',
			id: toLocalRef(session.ref),
		});

		if (!isOk(reply)) {
			onState({ kind: 'failed', line: readCrewLine(reply) || 'Not removed.' });

			return;
		}

		// Its name and mode go with it, and so does the page: back to Active, before the next listing
		// drops it.
		dispatch({ type: 'rename_session', ref: session.ref, name: '' });
		dispatch({ type: 'set_mode', ref: session.ref, mode: 'auto', by: 'page' });
		dispatch({ type: 'switch_view', view: { kind: 'active' } });
		onState(null);
	};

	if (state?.kind === 'asking') {
		return (
			<>
				<button type="button" className="btn sm danger" onClick={() => void remove()}>
					Remove: its folder stays
				</button>
				<button type="button" className="btn sm ghost" onClick={() => onState(null)}>
					Keep it
				</button>
			</>
		);
	}

	return (
		<>
			<button
				type="button"
				className="btn sm ghost danger"
				disabled={state?.kind === 'removing'}
				onClick={() => onState({ kind: 'asking' })}
			>
				Remove
			</button>
			{state?.kind === 'failed' && <span className="m">{state.line}</span>}
		</>
	);
};

// A session that has not started: why its stream is only history.
export const StoppedNote = ({ session, isOn }: { session: Session; isOn: boolean }) =>
	session.status === 'stopped' && !session.error ? (
		<div className="line notice c-dim">
			{isOn
				? 'Not running yet.'
				: 'Not active: its history only. Voice OS runs no Claude here and says nothing about it.'}
		</div>
	) : null;

export const Cockpit = ({ session, state, dispatch }: CockpitProps) => {
	const [isRenaming, setIsRenaming] = useState(false);
	const [removal, setRemoval] = useState<Removal>(null);
	const dialogs = useSessionDialogs(session, state);
	const now = useNow();
	const isOn = isActive(state, session.ref);
	const badge = describeSessionBadge(session, state.asks);

	return (
		<section className="vo-view vo-session" aria-label="session">
			<div className="vo-head">
				<span className={`dot ${badge.dot}`} />
				{isRenaming ? (
					<RenameSession
						sessionRef={session.ref}
						current={readSessionLabel(state, session.ref)}
						dispatch={dispatch}
						onDone={() => setIsRenaming(false)}
					/>
				) : (
					<h1 title={readRefTitle(state, session.ref)}>{readSessionLabel(state, session.ref)}</h1>
				)}
				<span className="m">{describeSessionMeta(state, session, now)}</span>
				<div className="row-actions">
					<button type="button" className="btn sm ghost rename" onClick={() => setIsRenaming(true)}>
						Rename
					</button>
					<button
						type="button"
						className="btn sm ghost toggle-active"
						onClick={() => dispatch({ type: isOn ? 'deactivate' : 'activate', ref: session.ref })}
					>
						{isOn ? 'Deactivate' : 'Activate'}
					</button>
					{session.isChat && (
						<RemoveChat
							session={session}
							dispatch={dispatch}
							state={removal}
							onState={setRemoval}
						/>
					)}
				</div>
			</div>
			<SessionStateRow state={state} sessionRef={session.ref} dispatch={dispatch} />
			<div className="vo-split">
				<SessionStream
					sessionRef={session.ref}
					session={session}
					className="vo-stream stream"
					hasAsk={state.asks.some((ask) => ask.ref === session.ref)}
					openFor={dialogs.openFor}
					peerRunFor={dialogs.peerRunFor}
				>
					<StoppedNote session={session} isOn={isOn} />
				</SessionStream>
				<aside className="vo-panels side">
					<SessionPanels session={session} state={state} dispatch={dispatch} dialogs={dialogs} />
				</aside>
			</div>
			{dialogs.dialogs}
		</section>
	);
};

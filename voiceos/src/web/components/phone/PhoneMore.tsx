// ⋯ on a phone: everything the desktop keeps beside the stream, full screen and in the same order —
// the session with its mode, model and context, sub-agents, other sessions' asks, dev servers, voice,
// notes, docs, elsewhere and where — then rename and deactivate. Local to this page: opening it moves
// no other tab.
import { type KeyboardEvent, useState } from 'react';
import { isActive } from '../../../shared/active.js';
import { readSessionLabel } from '../../../shared/machines.js';
import type { ClientMessage, Session, State } from '../../../shared/protocol.js';
import type { Dispatch } from '../../types.js';
import { type Removal, RemoveChat } from '../Cockpit.js';
import { ContextMeter } from '../ContextMeter.js';
import { ModeChip } from '../ModeChip.js';
import { ModelChip } from '../ModelChip.js';
import { RenameSession } from '../RenameSession.js';
import { type SessionDialogs, SessionPanels } from '../SessionPanels.js';
import { SessionTitle } from './PhoneTopBar.js';

interface PhoneMoreProps {
	session: Session;
	state: State;
	dispatch: Dispatch;
	send: (message: ClientMessage) => void;
	dialogs: SessionDialogs;
	onClose: () => void;
}

export const PhoneMore = ({ session, state, dispatch, send, dialogs, onClose }: PhoneMoreProps) => {
	const [isRenaming, setIsRenaming] = useState(false);
	const [removal, setRemoval] = useState<Removal>(null);
	const isOn = isActive(state, session.ref);

	// Esc closes this view only; the page's own Esc would leave the session.
	const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === 'Escape' && !event.defaultPrevented) {
			event.preventDefault();
			onClose();
		}
	};

	const chips = (
		<div className="mchips">
			<ModeChip state={state} sessionRef={session.ref} send={send} />
			<ModelChip state={state} sessionRef={session.ref} send={send} />
			{session.context && (
				<ContextMeter sessionRef={session.ref} context={session.context} send={send} />
			)}
		</div>
	);

	return (
		<section className="mpanel" aria-label="Session details" onKeyDown={handleKey}>
			<header className="mtop">
				<span />
				<SessionTitle state={state} session={session} />
				<button type="button" className="done" onClick={onClose}>
					Done
				</button>
			</header>
			<div className="scroll vo-panels side">
				<SessionPanels
					session={session}
					state={state}
					dispatch={dispatch}
					dialogs={dialogs}
					sessionExtra={chips}
				/>
				<div className="mfoot">
					{isRenaming ? (
						<RenameSession
							sessionRef={session.ref}
							current={readSessionLabel(state, session.ref)}
							dispatch={dispatch}
							onDone={() => setIsRenaming(false)}
						/>
					) : (
						<>
							<button type="button" className="btn" onClick={() => setIsRenaming(true)}>
								Rename
							</button>
							<button
								type="button"
								className="btn"
								onClick={() =>
									dispatch({ type: isOn ? 'deactivate' : 'activate', ref: session.ref })
								}
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
						</>
					)}
				</div>
			</div>
		</section>
	);
};

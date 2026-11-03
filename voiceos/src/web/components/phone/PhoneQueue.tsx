// The session's queued messages on a phone: a slim "2 queued" row right above the bar, and a sheet
// with each message, Send now and Cancel. The desktop folds the same list into its text box
// (QueueChip); a phone's bar has no room for it.
import { useState } from 'react';
import type { Session } from '../../../shared/protocol.js';
import type { Dispatch } from '../../types.js';
import { describePeers } from '../QueueChip.js';
import { QueuedText } from '../QueueList.js';

const TURN_STATUSES = new Set<Session['status']>(['starting', 'running', 'blocked']);

interface PhoneQueueProps {
	session: Session;
	dispatch: Dispatch;
}

export const PhoneQueue = ({ session, dispatch }: PhoneQueueProps) => {
	const [isOpen, setIsOpen] = useState(false);
	const { queue, ref } = session;
	const peers = describePeers(session);
	// Words to a session with no turn running wait too (an inactive one): "after this turn" only
	// while one runs.
	const isTurnRunning = TURN_STATUSES.has(session.status);
	const label = `${queue.length} queued${peers ? `, from ${peers}` : ''}${isTurnRunning ? ', sent after this turn' : ''}`;

	return (
		<>
			<button
				type="button"
				className="ph-queue"
				aria-expanded={isOpen}
				aria-label={label}
				onClick={() => setIsOpen(true)}
			>
				{peers && <i className="dot run" aria-hidden="true" />}
				<b>{queue.length}</b> queued
				{isTurnRunning && <span className="ph-queue-hint">after this turn</span>}
			</button>
			{isOpen && (
				<>
					<div className="mscrim" aria-hidden="true" onClick={() => setIsOpen(false)} />
					<section className="msheet ph-queue-sheet" aria-label="Queued messages">
						<header>
							<b>Queued</b>
							<span>
								{isTurnRunning
									? 'sent in order once this turn ends'
									: 'sent in order, one turn each'}
							</span>
							<button type="button" className="done" onClick={() => setIsOpen(false)}>
								Done
							</button>
						</header>
						<ol>
							{queue.map((item) => (
								<li key={item.id}>
									<p>
										<QueuedText item={item} />
									</p>
									<span className="ph-queue-acts">
										<button
											type="button"
											className="btn"
											onClick={() => dispatch({ type: 'promote_queued', ref, queuedId: item.id })}
										>
											Send now
										</button>
										<button
											type="button"
											className="btn x"
											onClick={() => dispatch({ type: 'cancel_queued', ref, queuedId: item.id })}
										>
											Cancel
										</button>
									</span>
								</li>
							))}
						</ol>
					</section>
				</>
			)}
		</>
	);
};

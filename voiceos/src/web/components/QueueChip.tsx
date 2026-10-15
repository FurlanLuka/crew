// The session's queued messages, folded into the box as "N queued": they were sent from here, so they
// sit with the composer instead of adding a row above it. Open, it lists them with ▲ now and ✕.
import { useCallback, useRef, useState } from 'react';
import type { Session } from '../../shared/protocol.js';
import type { Dispatch } from '../types.js';
import { useDismiss } from '../use-dismiss.js';
import { QueueList } from './QueueList.js';

interface QueueChipProps {
	session: Session;
	dispatch: Dispatch;
}

// Another session's tell waits in the queue too: the chip says so, since the rows are folded away.
const describePeers = (session: Session): string | null => {
	const labels = [
		...new Set(session.queue.flatMap((item) => (item.from ? [item.from.label] : []))),
	];

	return labels.length > 0 ? labels.join(', ') : null;
};

export const QueueChip = ({ session, dispatch }: QueueChipProps) => {
	const [isOpen, setIsOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const chipRef = useRef<HTMLButtonElement | null>(null);

	const closeMenu = useCallback(() => {
		// Back on the chip only when the keyboard was in the list; a press elsewhere keeps its own focus.
		const hadFocus = wrapRef.current?.contains(document.activeElement) ?? false;

		setIsOpen(false);

		if (hadFocus) {
			chipRef.current?.focus();
		}
	}, []);

	useDismiss(isOpen, wrapRef, closeMenu);

	const count = session.queue.length;
	const peers = describePeers(session);
	const label = `${count} queued${peers ? `, from ${peers}` : ''}`;

	return (
		<div className="qchip-wrap" ref={wrapRef}>
			<button
				ref={chipRef}
				type="button"
				className="qchip"
				aria-expanded={isOpen}
				aria-label={label}
				title={label}
				onClick={() => setIsOpen((open) => !open)}
			>
				{peers ? <i className="dot run" aria-hidden="true" /> : null}
				<b className="qchip-n">{count}</b> queued
			</button>
			{isOpen ? (
				<div className="qchip-pop">
					<QueueList session={session} dispatch={dispatch} />
				</div>
			) : null}
		</div>
	);
};

// How full the session's context is, right of the box: tap it to compact or clear. Both go to the
// session as /compact and /clear, so Voice OS's own confirm comes first.
import { useCallback, useRef, useState } from 'react';
import { useDismiss } from '../use-dismiss.js';
import {
	describeContextLevel,
	describeContextTitle,
	formatContextUsage,
} from '../../shared/context-meter.js';
import type { ClientMessage, ContextUsage } from '../../shared/protocol.js';

const ACTIONS = [
	{ command: '/compact', name: 'Compact', hint: 'Summarize the conversation so far' },
	{ command: '/clear', name: 'Clear', hint: 'Start a fresh conversation' },
] as const;

interface ContextMeterProps {
	sessionRef: string;
	context: ContextUsage;
	send: (message: ClientMessage) => void;
}

export const ContextMeter = ({ sessionRef, context, send }: ContextMeterProps) => {
	const [isOpen, setIsOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const closeMenu = useCallback(() => setIsOpen(false), []);

	useDismiss(isOpen, wrapRef, closeMenu);

	const run = (command: string) => {
		setIsOpen(false);
		send({ type: 'action', action: { type: 'send', ref: sessionRef, text: command } });
	};

	const title = describeContextTitle(context);

	return (
		<div className="ctx-wrap" ref={wrapRef}>
			<button
				type="button"
				className={`ctx-meter ${describeContextLevel(context)}`}
				aria-haspopup="menu"
				aria-expanded={isOpen}
				aria-label={title}
				title={title}
				onClick={() => setIsOpen((open) => !open)}
			>
				{formatContextUsage(context)}
			</button>
			{isOpen ? (
				<div className="ctx-menu" role="menu">
					{ACTIONS.map((action) => (
						<button
							key={action.command}
							type="button"
							role="menuitem"
							className="perm-option"
							onClick={() => run(action.command)}
						>
							<span className="name">{action.name}</span>
							<span className="hint">{action.hint}</span>
						</button>
					))}
				</div>
			) : null}
		</div>
	);
};

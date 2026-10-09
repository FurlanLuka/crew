// The session's permission mode, left of the box: tap it, pick another. The state says the mode;
// the chip follows it, so a pick shows once Voice OS has taken it.
import { useCallback, useRef, useState } from 'react';
import { useDismiss } from '../use-dismiss.js';
import { MODE_LABELS } from '../../shared/modes.js';
import {
	SESSION_MODES,
	type ClientMessage,
	type SessionMode,
	type State,
} from '../../shared/protocol.js';
import { canChooseMode, readMode } from '../../shared/modes.js';

const MODE_HINTS: Record<SessionMode, string> = {
	auto: "Claude Code's classifier decides",
	plan: 'It plans and changes nothing',
	ask: 'Every permission comes to you',
	skip: 'It runs everything, nothing checked',
};

// Short on the chip; the menu says the full name.
const CHIP_LABELS: Record<SessionMode, string> = { ...MODE_LABELS, skip: 'Skip' };

interface ModeChipProps {
	state: State;
	sessionRef: string;
	send: (message: ClientMessage) => void;
}

export const ModeChip = ({ state, sessionRef, send }: ModeChipProps) => {
	const [isOpen, setIsOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const closeMenu = useCallback(() => setIsOpen(false), []);
	const mode = readMode(state, sessionRef);

	useDismiss(isOpen, wrapRef, closeMenu);

	if (!canChooseMode(state, sessionRef)) {
		return null;
	}

	const pick = (next: SessionMode) => {
		setIsOpen(false);

		if (next !== mode) {
			send({
				type: 'action',
				action: { type: 'set_mode', ref: sessionRef, mode: next, by: 'page' },
			});
		}
	};

	return (
		<div className="perm-wrap" ref={wrapRef}>
			<button
				type="button"
				className={`perm-chip ${mode}`}
				aria-haspopup="menu"
				aria-expanded={isOpen}
				aria-label={`Permission mode: ${MODE_LABELS[mode]}`}
				title={`Permission mode: ${MODE_LABELS[mode]}`}
				onClick={() => setIsOpen((open) => !open)}
			>
				{CHIP_LABELS[mode]}
			</button>
			{isOpen ? (
				<div className="perm-menu" role="menu">
					{SESSION_MODES.map((option) => (
						<button
							key={option}
							type="button"
							role="menuitemradio"
							aria-checked={option === mode}
							className={`perm-option ${option} ${option === mode ? 'on' : ''}`}
							onClick={() => pick(option)}
						>
							<span className="name">{MODE_LABELS[option]}</span>
							<span className="hint">{MODE_HINTS[option]}</span>
						</button>
					))}
				</div>
			) : null}
		</div>
	);
};

// A session left in Skip shows it off-screen too: on its tab and its Active row.
export const SkipBadge = () => (
	<span className="skip-badge" title="Skip permissions: it runs everything, nothing checked">
		skip
	</span>
);

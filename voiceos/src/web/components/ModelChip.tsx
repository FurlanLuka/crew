// The session's model, beside its permission mode: tap it, pick another, the same switch /model
// makes. The state says the model Claude Code reported; the chip follows it, so a pick shows once
// the session has taken it.
import { useCallback, useRef, useState } from 'react';
import type { ClientMessage, State } from '../../shared/protocol.js';
import { MODEL_CHOICES, describeModel, isSameModel } from '../models.js';
import { useDismiss } from '../use-dismiss.js';

interface ModelChipProps {
	state: State;
	sessionRef: string;
	send: (message: ClientMessage) => void;
}

export const ModelChip = ({ state, sessionRef, send }: ModelChipProps) => {
	const [isOpen, setIsOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const closeMenu = useCallback(() => setIsOpen(false), []);
	const model = state.sessions[sessionRef]?.model ?? null;

	useDismiss(isOpen, wrapRef, closeMenu);

	if (!model) {
		return null;
	}

	const said = describeModel(model);

	const pick = (next: string) => {
		setIsOpen(false);

		if (!isSameModel(next, model)) {
			send({ type: 'action', action: { type: 'set_model', ref: sessionRef, model: next } });
		}
	};

	return (
		<div className="perm-wrap model-wrap" ref={wrapRef}>
			<button
				type="button"
				className="perm-chip model-chip"
				aria-haspopup="menu"
				aria-expanded={isOpen}
				aria-label={`Model: ${said}`}
				title={`Model: ${model}`}
				onClick={() => setIsOpen((open) => !open)}
			>
				{said}
			</button>
			{isOpen ? (
				<div className="perm-menu" role="menu">
					{MODEL_CHOICES.map((choice) => {
						const isOn = isSameModel(choice.id, model);

						return (
							<button
								key={choice.id}
								type="button"
								role="menuitemradio"
								aria-checked={isOn}
								className={`perm-option ${isOn ? 'on' : ''}`}
								onClick={() => pick(choice.id)}
							>
								<span className="name">{describeModel(choice.id)}</span>
								<span className="hint">{choice.hint}</span>
							</button>
						);
					})}
				</div>
			) : null}
		</div>
	);
};

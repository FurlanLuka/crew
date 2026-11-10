// The session's model, beside its permission mode: tap it, pick another, the same switch /model
// makes. The state says the model Claude Code reported; the chip follows it, so a pick shows once
// the session has taken it. The menu is the list the session's Claude Code gave; before it has one
// (or from an older remote) the chip only says the model.
import { useCallback, useRef, useState } from 'react';
import type { ClientMessage, State } from '../../shared/protocol.js';
import { describeSessionModel, findCurrentModel, readChipModel } from '../models.js';
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
	const session = state.sessions[sessionRef];
	const model = session?.model ?? null;
	const models = session?.models ?? [];

	useDismiss(isOpen, wrapRef, closeMenu);

	if (!model) {
		return null;
	}

	const windowTokens = session?.context?.max ?? null;
	const said = describeSessionModel(readChipModel(models, model), windowTokens);
	const current = findCurrentModel(models, model);

	if (models.length === 0) {
		return (
			<div className="perm-wrap model-wrap">
				<span className="perm-chip model-chip" title={`Model: ${model}`}>
					{said}
				</span>
			</div>
		);
	}

	const pick = (next: string) => {
		setIsOpen(false);

		if (next !== current?.id) {
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
					{models.map((choice) => {
						const isOn = choice.id === current?.id;

						return (
							<button
								key={choice.id}
								type="button"
								role="menuitemradio"
								aria-checked={isOn}
								className={`perm-option ${isOn ? 'on' : ''}`}
								onClick={() => pick(choice.id)}
							>
								<span className="name">{choice.name}</span>
								<span className="hint">{choice.description}</span>
							</button>
						);
					})}
				</div>
			) : null}
		</div>
	);
};

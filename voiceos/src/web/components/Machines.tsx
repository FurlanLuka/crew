import { useState, type FormEvent } from 'react';
import type { State } from '../../shared/protocol.js';
import { isValidHost } from '../../shared/machines.js';
import { describePinnedCard, listMachineCards, type MachineCard } from '../derive.js';
import type { Dispatch } from '../types.js';
import { VoicePanel } from './VoicePanel.js';
import { NotesPanel } from './NotesPanel.js';
import { focusOnMount } from './focus-on-mount.js';

interface MachinesProps {
	state: State;
	dispatch: Dispatch;
}

interface CardProps {
	card: MachineCard;
	dispatch: Dispatch;
}

const formatCounts = ({ total, running, waiting }: MachineCard['counts']): string =>
	[
		`${total} ${total === 1 ? 'session' : 'sessions'}`,
		running > 0 ? `${running} running` : '',
		waiting > 0 ? `${waiting} waiting` : '',
	]
		.filter(Boolean)
		.join(' · ');

const MachineCardView = ({ card, dispatch }: CardProps) => {
	const [name, setName] = useState<string | null>(null);

	const open = () => dispatch({ type: 'switch_view', view: { kind: 'grid', machine: card.id } });

	const rename = (event: FormEvent) => {
		event.preventDefault();

		if (name?.trim()) {
			dispatch({ type: 'rename_machine', id: card.id, name: name.trim() });
		}

		setName(null);
	};

	const remove = () => {
		// Its sessions keep running there; this Voice OS just stops driving them.
		if (window.confirm(`Remove ${card.name}? Its sessions keep running there.`)) {
			dispatch({ type: 'remove_machine', id: card.id });
		}
	};

	return (
		<section className={`machine ${card.dot}`} aria-label={card.name}>
			<div className="machine-head">
				<i className={`dot machine-dot ${card.dot}`} />
				{name === null ? (
					<button type="button" className="machine-name" onClick={open}>
						{card.name}
					</button>
				) : (
					<form onSubmit={rename} className="machine-rename">
						<input
							// The name field opens by the rename button: typing goes straight into it.
							ref={focusOnMount}
							value={name}
							maxLength={60}
							aria-label="machine name"
							onChange={(event) => setName(event.target.value)}
							onBlur={() => setName(null)}
						/>
					</form>
				)}
				{card.isRemote && name === null && (
					<span className="machine-actions">
						<button type="button" className="btn small" onClick={() => setName(card.name)}>
							rename
						</button>
						<button type="button" className="btn small danger" onClick={remove}>
							remove
						</button>
					</span>
				)}
			</div>
			<button type="button" className="machine-body" onClick={open}>
				<span className="machine-where">{card.where}</span>
				<span className="machine-counts">{formatCounts(card.counts)}</span>
				{card.waiting ? (
					<span className="machine-waiting">{card.waiting}</span>
				) : (
					<span className="machine-quiet">{card.detail ?? 'Nothing waiting on you'}</span>
				)}
			</button>
		</section>
	);
};

// Not a machine: no status, no where, nothing to rename; it gathers the pins from every machine.
const PinnedCardView = ({ state, dispatch }: MachinesProps) => {
	const { counts, waiting } = describePinnedCard(state);

	const open = () => dispatch({ type: 'switch_view', view: { kind: 'pinned' } });

	return (
		<section className={`machine pinned ${waiting ? 'crit' : ''}`} aria-label="Pinned">
			<div className="machine-head">
				<button type="button" className="machine-name" onClick={open}>
					Pinned
				</button>
			</div>
			<button type="button" className="machine-body" onClick={open}>
				<span className="machine-counts">{formatCounts(counts)}</span>
				{waiting ? (
					<span className="machine-waiting">{waiting}</span>
				) : (
					<span className="machine-quiet">
						{state.pinned.length === 0 ? 'Pin a session to keep it here' : 'Nothing waiting on you'}
					</span>
				)}
			</button>
		</section>
	);
};

interface AddMachineDialogProps {
	dispatch: Dispatch;
	onClose: () => void;
}

const AddMachineDialog = ({ dispatch, onClose }: AddMachineDialogProps) => {
	const [host, setHost] = useState('');
	const [name, setName] = useState('');
	const isValid = isValidHost(host.trim());

	const add = (event: FormEvent) => {
		event.preventDefault();

		if (!isValid) {
			return;
		}

		dispatch({
			type: 'add_machine',
			host: host.trim(),
			...(name.trim() ? { name: name.trim() } : {}),
		});
		onClose();
	};

	// A real modal: Esc closes it (the dialog's own cancel), and nothing behind it takes clicks.
	return (
		<dialog
			className="dialog"
			aria-label="add a machine"
			ref={(dialog) => {
				if (dialog && !dialog.open) {
					dialog.showModal();
				}
			}}
			onClose={onClose}
		>
			<form className="dialog-form" onSubmit={add}>
				<h2 className="dialog-title">Add a machine</h2>
				<p className="hint">
					Another computer or VM whose sessions this Voice OS drives over SSH. On it, install crew
					and run <b>crew voice remote</b> once; from here, <b>ssh &lt;host&gt;</b> must log in
					without a password.
				</p>
				<label className="dialog-field">
					<span>SSH host</span>
					<input
						// Opened to type the host: focus goes straight there.
						ref={focusOnMount}
						value={host}
						onChange={(event) => setHost(event.target.value)}
						placeholder="vm1, or dev@vm1.example.com"
						aria-label="SSH host"
					/>
				</label>
				<label className="dialog-field">
					<span>Name (optional)</span>
					<input
						value={name}
						maxLength={60}
						onChange={(event) => setName(event.target.value)}
						placeholder="Build box"
						aria-label="name"
					/>
				</label>
				<div className="dialog-actions">
					<button type="button" className="btn small" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn small primary" disabled={!isValid}>
						Add
					</button>
				</div>
			</form>
		</dialog>
	);
};

export const Machines = ({ state, dispatch }: MachinesProps) => {
	const [isAdding, setIsAdding] = useState(false);

	return (
		<main className="mission">
			<div className="grid machines">
				<PinnedCardView state={state} dispatch={dispatch} />
				{listMachineCards(state).map((card) => (
					<MachineCardView key={card.id} card={card} dispatch={dispatch} />
				))}
				<button type="button" className="machine add" onClick={() => setIsAdding(true)}>
					<span className="machine-add-title">+ Add machine</span>
					<span className="hint">Another computer or VM, over SSH</span>
				</button>
			</div>
			<aside className="side">
				<VoicePanel state={state} screen={null} />
				<NotesPanel state={state} screen={null} />
			</aside>
			{isAdding && <AddMachineDialog dispatch={dispatch} onClose={() => setIsAdding(false)} />}
		</main>
	);
};

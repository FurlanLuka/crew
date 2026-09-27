import { useState } from 'react';
import type { State } from '../../shared/protocol.js';
import { readNotesFor } from '../derive.js';

interface NotesPanelProps {
	state: State;
	screen: string | null;
}

export const NotesPanel = ({ state, screen }: NotesPanelProps) => {
	// Closed until asked for: the notes are for reading back, not for watching.
	const [isOpen, setIsOpen] = useState(false);
	const lines = readNotesFor(state, screen);

	return (
		<section className="panel notes" aria-label="notes">
			<button
				type="button"
				className="lbl notes-toggle"
				aria-expanded={isOpen}
				onClick={() => setIsOpen((open) => !open)}
			>
				{isOpen ? '▾' : '▸'} notes · {lines.length}
			</button>
			{isOpen && lines.length === 0 && (
				<div className="row c-dim">nothing noted here yet — say "note: …"</div>
			)}
			{isOpen &&
				lines.map((line, index) => (
					<div key={`${index}-${line}`} className="note">
						{line.replace(/^- /, '')}
					</div>
				))}
		</section>
	);
};

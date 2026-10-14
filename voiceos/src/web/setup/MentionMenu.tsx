// The "@" menu above the setup chat's box: this machine's worktrees, then its projects. The slash
// menu's look, so the two read as one kind of thing.
import type { Mentions } from './use-mentions.js';

interface MentionMenuProps {
	mentions: Mentions;
	// After a pick: the box takes the focus back.
	onPicked: () => void;
}

export const MentionMenu = ({ mentions, onPicked }: MentionMenuProps) =>
	mentions.entries.length === 0 ? null : (
		<div className="slash-menu" role="listbox" aria-label="Worktrees and projects">
			{mentions.entries.map((entry, index) => (
				<div
					key={`${entry.kind} ${entry.value}`}
					role="option"
					tabIndex={-1}
					aria-selected={index === mentions.selected}
					className={`slash-item ${index === mentions.selected ? 'selected' : ''}`}
					// Picked on press, so the box keeps its focus.
					onMouseDown={(event) => {
						event.preventDefault();
						mentions.choose(entry);
						onPicked();
					}}
				>
					<span className="slash-name">{entry.value}</span>
					<span className="slash-description">{entry.kind}</span>
				</div>
			))}
		</div>
	);

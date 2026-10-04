// The "/" menu above a session's box: its own commands, then Voice OS's, and under the box what a
// Voice OS command said back.
import type { SlashCommands } from '../use-slash-commands.js';

interface SlashMenuProps {
	slash: SlashCommands;
	// After a pick: the box takes the focus back.
	onPicked: () => void;
}

// The menu while one is open, else what the last Voice OS command said.
export const SlashMenu = ({ slash, onPicked }: SlashMenuProps) => {
	if (slash.entries.length === 0) {
		return <SlashLine slash={slash} />;
	}

	const firstOurs = slash.entries.findIndex((entry) => entry.source === 'voice-os');

	return (
		<div className="slash-menu" role="listbox" aria-label="Commands">
			{slash.entries.map((entry, index) => (
				<div key={`${entry.source}:${entry.name}`} className="slash-group">
					{index === firstOurs ? <div className="slash-heading">Voice OS</div> : null}
					<div
						role="option"
						tabIndex={-1}
						aria-selected={index === slash.selected}
						className={`slash-item ${index === slash.selected ? 'selected' : ''}`}
						// Picked on press, so the box keeps its focus.
						onMouseDown={(event) => {
							event.preventDefault();
							slash.choose(entry);
							onPicked();
						}}
					>
						<span className="slash-name">/{entry.name}</span>
						{entry.argumentHint ? <span className="slash-hint">{entry.argumentHint}</span> : null}
						<span className="slash-description">{entry.description}</span>
					</div>
				</div>
			))}
		</div>
	);
};

const SlashLine = ({ slash }: { slash: SlashCommands }) =>
	slash.line ? (
		<div className={`slash-line ${slash.line.isError ? 'error' : ''}`} role="status">
			<span>{slash.line.text}</span>
			{slash.line.offersRestart ? (
				<button type="button" className="btn sm primary" onClick={slash.restart}>
					Restart crew's server
				</button>
			) : null}
			<button type="button" className="att-x" aria-label="Dismiss" onClick={slash.dismissLine}>
				✕
			</button>
		</div>
	) : null;

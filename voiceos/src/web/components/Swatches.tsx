// A group's six colours, the chosen one ringed: in the name popover and in a group's menu.
import { GROUP_COLORS, type GroupColor } from '../../shared/protocol.js';

interface SwatchesProps {
	selected: GroupColor;
	onPick: (color: GroupColor) => void;
}

export const Swatches = ({ selected, onPick }: SwatchesProps) => (
	<div className="vo-swatches">
		{GROUP_COLORS.map((color) => (
			<button
				key={color}
				type="button"
				className="vo-swatch"
				data-color={color}
				aria-label={color}
				aria-pressed={color === selected}
				onClick={() => onPick(color)}
			/>
		))}
	</div>
);

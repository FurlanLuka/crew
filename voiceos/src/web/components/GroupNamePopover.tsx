// Naming a group: right after a tab is dropped on another (name and colour; nothing is made until
// Create), or Rename from a group's menu (the name alone; its colour is changed from the menu).
import { type FormEvent, type KeyboardEvent, useRef, useState } from 'react';
import { MAX_GROUP_NAME_LENGTH, toGroupName } from '../../shared/groups.js';
import type { GroupColor } from '../../shared/protocol.js';
import { useClickOutside } from '../menu-keys.js';
import { fitSpot, type Spot } from '../use-menu-press.js';
import { focusOnMount } from './focus-on-mount.js';
import { Swatches } from './Swatches.js';

// .vo-namepop's width.
const POPOVER_WIDTH = 280;

type Naming =
	| {
			mode: 'create';
			// The workspace the two share, or ''.
			initialName: string;
			initialColor: GroupColor;
			// Who goes in ("store-front + checkout").
			members: string;
			onSubmit: (name: string, color: GroupColor) => void;
	  }
	| { mode: 'rename'; initialName: string; onSubmit: (name: string) => void };

type GroupNamePopoverProps = Naming & {
	spot: Spot;
	onCancel: () => void;
};

export const GroupNamePopover = (props: GroupNamePopoverProps) => {
	const { spot, initialName, onCancel } = props;
	const [name, setName] = useState(initialName);
	const [color, setColor] = useState(props.mode === 'create' ? props.initialColor : null);
	const wrapRef = useRef<HTMLFormElement | null>(null);
	const title = props.mode === 'create' ? 'Name this group' : 'Rename group';
	const kept = toGroupName(name);

	useClickOutside(true, wrapRef, onCancel);

	const submit = (event: FormEvent) => {
		event.preventDefault();

		if (!kept) {
			return;
		}

		if (props.mode === 'create') {
			props.onSubmit(kept, color ?? props.initialColor);
		} else {
			props.onSubmit(kept);
		}
	};

	// On the form, not the field: Esc from a swatch must not reach the page's Esc and leave the view.
	const handleKey = (event: KeyboardEvent<HTMLFormElement>) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			onCancel();
		}
	};

	return (
		<form
			ref={wrapRef}
			className="vo-namepop"
			aria-label={title}
			style={{ left: fitSpot(spot, POPOVER_WIDTH, window.innerWidth).x, top: spot.y }}
			onSubmit={submit}
			onKeyDown={handleKey}
		>
			<label className="vo-namepop-cap" htmlFor="vo-group-name">
				{title}
			</label>
			<input
				id="vo-group-name"
				ref={focusOnMount}
				value={name}
				maxLength={MAX_GROUP_NAME_LENGTH}
				placeholder="e.g. store"
				autoComplete="off"
				onChange={(event) => setName(event.target.value)}
			/>
			{color && <Swatches selected={color} onPick={setColor} />}
			{props.mode === 'create' && <small>{props.members}</small>}
			<div className="vo-namepop-row">
				<button type="button" className="vo-namepop-cancel" onClick={onCancel}>
					Cancel
				</button>
				<button type="submit" className="vo-namepop-ok" disabled={!kept}>
					{props.mode === 'create' ? 'Create group' : 'Rename'}
				</button>
			</div>
		</form>
	);
};

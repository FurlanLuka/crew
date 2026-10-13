// The top bar's right-click menus (a long press on touch, the Menu key on a focused tab): a session
// tab's groups and deactivate, a group chip's open, rename, colour and ungroup.
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { findGroupOf, layoutBar } from '../../shared/groups.js';
import type { SessionGroup, State } from '../../shared/protocol.js';
import { readSessionLabel } from '../../shared/machines.js';
import { handleMenuKey, useClickOutside } from '../menu-keys.js';
import type { Dispatch } from '../types.js';
import { fitSpot, type Spot } from '../use-menu-press.js';
import { Swatches } from './Swatches.js';

// A group's colour swatches are stops for the arrows too.
const MENU_STOPS = '[role="menuitem"], .vo-swatch';
// .vo-barmenu's width.
const MENU_WIDTH = 260;

export interface TabMenuModel {
	// The group it is in, if any.
	group: SessionGroup | null;
	// Groups the bar draws that it can be added (or moved) to.
	others: SessionGroup[];
	// Loose tabs it can start a group with.
	partners: string[];
}

export const readTabMenu = (state: State, ref: string): TabMenuModel => {
	const group = findGroupOf(state.groups, ref);
	const items = layoutBar(state);

	return {
		group,
		others: items.flatMap((item) =>
			item.kind === 'group' && item.group !== group ? [item.group] : [],
		),
		partners: items.flatMap((item) =>
			item.kind === 'session' && item.ref !== ref && !findGroupOf(state.groups, item.ref)
				? [item.ref]
				: [],
		),
	};
};

interface BarMenuProps {
	label: string;
	// Where Esc gives the focus back: the tab or chip the menu came from.
	opener: Element | null;
	spot: Spot;
	onClose: () => void;
	children: ReactNode;
}

const BarMenu = ({ label, opener, spot, onClose, children }: BarMenuProps) => {
	const menuRef = useRef<HTMLDivElement | null>(null);

	useClickOutside(true, menuRef, onClose);

	useEffect(() => {
		menuRef.current?.querySelector<HTMLElement>(MENU_STOPS)?.focus();
	}, []);

	return (
		<div
			ref={menuRef}
			className="nm-menu vo-barmenu"
			role="menu"
			aria-label={label}
			style={{ left: fitSpot(spot, MENU_WIDTH, window.innerWidth).x, top: spot.y }}
			onKeyDown={(event) =>
				handleMenuKey(event, {
					stops: MENU_STOPS,
					onEscape: () => {
						onClose();

						if (opener instanceof HTMLElement) {
							opener.focus();
						}
					},
					onTab: onClose,
				})
			}
		>
			{children}
		</div>
	);
};

interface TabMenuProps {
	state: State;
	dispatch: Dispatch;
	sessionRef: string;
	spot: Spot;
	onClose: () => void;
	// "New group with…" picked a partner: the name comes next.
	onNewGroup: (partner: string) => void;
}

export const TabMenu = ({
	state,
	dispatch,
	sessionRef,
	spot,
	onClose,
	onNewGroup,
}: TabMenuProps) => {
	const { group, others, partners } = readTabMenu(state, sessionRef);
	const [isPickingPartner, setIsPickingPartner] = useState(false);
	// Read once, as the menu opens: the partner list replaces the item that had the focus.
	const [opener] = useState(() => document.activeElement);

	const pick = (run: () => void) => {
		onClose();
		run();
	};

	if (isPickingPartner) {
		return (
			<BarMenu key="partners" label="New group with" opener={opener} spot={spot} onClose={onClose}>
				<div className="nm-cap" aria-hidden="true">
					Group with
				</div>
				{partners.map((partner) => (
					<button
						key={partner}
						type="button"
						role="menuitem"
						className="nm-item"
						onClick={() => pick(() => onNewGroup(partner))}
					>
						<span className="nm-text">{readSessionLabel(state, partner)}</span>
					</button>
				))}
			</BarMenu>
		);
	}

	return (
		<BarMenu
			key="tab"
			label={readSessionLabel(state, sessionRef)}
			opener={opener}
			spot={spot}
			onClose={onClose}
		>
			{others.length > 0 && (
				<div className="nm-cap" aria-hidden="true">
					{group ? 'Move to group' : 'Add to group'}
				</div>
			)}
			{others.map((other) => (
				<button
					key={other.id}
					type="button"
					role="menuitem"
					className="nm-item"
					onClick={() =>
						pick(() => dispatch({ type: 'join_group', id: other.id, ref: sessionRef }))
					}
				>
					<span className="vo-swatch-dot" data-color={other.color} aria-hidden="true" />
					<span className="nm-text">{other.name}</span>
				</button>
			))}
			{partners.length > 0 && (
				<button
					type="button"
					role="menuitem"
					className="nm-item"
					onClick={() => setIsPickingPartner(true)}
				>
					<span className="nm-text">New group with…</span>
					<span className="nm-go" aria-hidden="true">
						›
					</span>
				</button>
			)}
			{group && (
				<button
					type="button"
					role="menuitem"
					className="nm-item"
					onClick={() => pick(() => dispatch({ type: 'leave_group', ref: sessionRef }))}
				>
					<span className="nm-text">Take out of {group.name}</span>
				</button>
			)}
			<div className="nm-sep" />
			<button
				type="button"
				role="menuitem"
				className="nm-item vo-danger"
				onClick={() => pick(() => dispatch({ type: 'deactivate', ref: sessionRef }))}
			>
				<span className="nm-text">Deactivate</span>
			</button>
		</BarMenu>
	);
};

interface GroupMenuProps {
	state: State;
	dispatch: Dispatch;
	group: SessionGroup;
	spot: Spot;
	onClose: () => void;
	onRename: () => void;
}

export const GroupMenu = ({ state, dispatch, group, spot, onClose, onRename }: GroupMenuProps) => {
	const [opener] = useState(() => document.activeElement);
	const isOpen = state.openGroup === group.id;

	const pick = (run: () => void) => {
		onClose();
		run();
	};

	return (
		<BarMenu label={group.name} opener={opener} spot={spot} onClose={onClose}>
			<button
				type="button"
				role="menuitem"
				className="nm-item"
				onClick={() => pick(() => dispatch({ type: 'open_group', id: isOpen ? null : group.id }))}
			>
				<span className="nm-text">{isOpen ? 'Close' : 'Open'}</span>
			</button>
			<button type="button" role="menuitem" className="nm-item" onClick={() => pick(onRename)}>
				<span className="nm-text">Rename…</span>
			</button>
			<div className="nm-cap" aria-hidden="true">
				Colour
			</div>
			<Swatches
				selected={group.color}
				onPick={(color) => dispatch({ type: 'update_group', id: group.id, color })}
			/>
			<div className="nm-sep" />
			<button
				type="button"
				role="menuitem"
				className="nm-item"
				onClick={() => pick(() => dispatch({ type: 'ungroup', id: group.id }))}
			>
				<span className="nm-text">Ungroup</span>
			</button>
		</BarMenu>
	);
};

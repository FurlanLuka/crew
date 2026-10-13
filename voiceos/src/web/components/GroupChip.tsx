// A group in the top bar, in its own colour. Closed: one chip with its members' dots (the one that
// most needs the developer first), its name and its count, red when one of them needs them. Open: the
// bar holds only it — its name, its tabs, and ‹ to close, with a red dot when a hidden session needs
// the developer.
import type { HTMLAttributes, ReactNode } from 'react';
import type { SessionGroup } from '../../shared/protocol.js';
import type { GroupLook } from '../derive.js';
import { type Spot, useMenuPress } from '../use-menu-press.js';
import type { BarDragProps } from './use-bar-drag.js';

interface GroupChipProps {
	group: SessionGroup;
	look: GroupLook;
	count: number;
	dragClass: string;
	drag: BarDragProps;
	keyProps: Pick<HTMLAttributes<HTMLButtonElement>, 'onKeyDown' | 'aria-keyshortcuts'>;
	onOpen: () => void;
	onMenu: (spot: Spot) => void;
}

export const GroupChip = ({
	group,
	look,
	count,
	dragClass,
	drag,
	keyProps,
	onOpen,
	onMenu,
}: GroupChipProps) => {
	const press = useMenuPress(onMenu);

	return (
		<button
			type="button"
			className={`vo-tab vo-gchip ${look.holdsScreen ? 'holds' : ''} ${dragClass}`}
			data-group={group.id}
			data-color={group.color}
			title={group.name}
			{...drag}
			{...keyProps}
			{...press}
			onClick={onOpen}
		>
			<span className="vo-gdots" aria-hidden="true">
				{look.dots.map((dot, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: dots are positional, several share a state.
					<span key={index} className={`dot ${dot}`} />
				))}
			</span>
			<b>{group.name}</b>
			<span className={`vo-count ${look.isAlarm ? 'alarm' : ''}`}>{count}</span>
		</button>
	);
};

interface GroupBoxProps {
	group: SessionGroup;
	hasHiddenAlarm: boolean;
	children: ReactNode;
	onClose: () => void;
	onMenu: (spot: Spot) => void;
}

export const GroupBox = ({ group, hasHiddenAlarm, children, onClose, onMenu }: GroupBoxProps) => {
	const press = useMenuPress(onMenu);

	return (
		<div className="vo-gbox" data-group={group.id} data-color={group.color}>
			<button
				type="button"
				className="vo-tab vo-gname"
				title={`Close ${group.name}`}
				{...press}
				onClick={onClose}
			>
				<b>{group.name}</b>
			</button>
			{children}
			<button
				type="button"
				className={`vo-tab vo-fold ${hasHiddenAlarm ? 'alarm' : ''}`}
				aria-label={
					hasHiddenAlarm
						? `Close ${group.name}: a session outside it needs you`
						: `Close ${group.name}`
				}
				title={hasHiddenAlarm ? 'A session outside this group needs you' : `Close ${group.name}`}
				onClick={onClose}
			>
				‹{hasHiddenAlarm && <span className="dot blocked" />}
			</button>
		</div>
	);
};

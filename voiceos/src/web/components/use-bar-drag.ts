// Dragging in the top bar: a tab or a group to another place, a tab onto a group to join it, a tab
// onto a loose tab to start one. The carried item dims; a line shows where it lands, an outline
// what it joins.
import { type DragEvent, useState } from 'react';
import type { BarItem } from '../../shared/groups.js';
import type { SessionGroup } from '../../shared/protocol.js';
import type { Dispatch } from '../types.js';
import { canJoin, type DropZone, readDrop, readDropZone, readItemKey } from './bar-moves.js';

// Its own type, so a tab dropped on the text box never pastes its ref there.
const DRAG_TYPE = 'application/x-voiceos-ref';

interface UseBarDragParams {
	items: BarItem[];
	groups: SessionGroup[];
	isOpenBox: boolean;
	dispatch: Dispatch;
	// A tab dropped on the middle of a loose tab: the group is named before it is made.
	onName: (target: string, dragged: string, anchor: DOMRect) => void;
}

export interface BarDragProps {
	draggable: boolean;
	onDragStart: (event: DragEvent<HTMLElement>) => void;
	onDragOver: (event: DragEvent<HTMLElement>) => void;
	onDrop: (event: DragEvent<HTMLElement>) => void;
	onDragEnd: () => void;
}

export interface BarDrag {
	propsFor: (item: BarItem) => BarDragProps;
	classFor: (item: BarItem) => string;
	onNavDragLeave: (event: DragEvent<HTMLElement>) => void;
}

export const useBarDrag = ({
	items,
	groups,
	isOpenBox,
	dispatch,
	onName,
}: UseBarDragParams): BarDrag => {
	const [dragged, setDragged] = useState<string | null>(null);
	const [drop, setDrop] = useState<{ key: string; zone: DropZone } | null>(null);

	const draggedItem = items.find((item) => readItemKey(item) === dragged) ?? null;

	const endDrag = () => {
		setDragged(null);
		setDrop(null);
	};

	const land = (target: BarItem, zone: DropZone, anchor: DOMRect) => {
		if (!draggedItem) {
			return;
		}

		const action = readDrop({ items, dragged: draggedItem, target, zone });

		switch (action.kind) {
			case 'join':
				dispatch({ type: 'join_group', id: action.id, ref: action.ref });
				break;
			case 'name':
				onName(action.target, action.dragged, anchor);
				break;
			case 'move_group':
				dispatch({ type: 'move_group', id: action.id, before: action.before });
				break;
			case 'move_active':
				dispatch({ type: 'move_active', ref: action.ref, before: action.before });
				break;
		}
	};

	const propsFor = (item: BarItem): BarDragProps => {
		const key = readItemKey(item);

		return {
			draggable: true,
			onDragStart: (event) => {
				event.dataTransfer.effectAllowed = 'move';
				event.dataTransfer.setData(DRAG_TYPE, key);
				setDragged(key);
			},
			onDragOver: (event) => {
				if (!draggedItem) {
					return;
				}

				// Back over itself nothing would move: no line promises otherwise.
				if (dragged === key) {
					setDrop(null);

					return;
				}

				event.preventDefault();
				const rect = event.currentTarget.getBoundingClientRect();
				const zone = readDropZone(
					event.clientX - rect.left,
					rect.width,
					canJoin({ dragged: draggedItem, target: item, groups, isOpenBox }),
				);

				if (drop?.key !== key || drop.zone !== zone) {
					setDrop({ key, zone });
				}
			},
			onDrop: (event) => {
				event.preventDefault();

				if (drop?.key === key) {
					land(item, drop.zone, event.currentTarget.getBoundingClientRect());
				}

				endDrag();
			},
			onDragEnd: endDrag,
		};
	};

	const classFor = (item: BarItem): string => {
		const key = readItemKey(item);

		return [dragged === key ? 'dragging' : '', drop?.key === key ? `drop-${drop.zone}` : '']
			.filter(Boolean)
			.join(' ');
	};

	// Leaving the bar altogether drops the promise of a landing.
	const onNavDragLeave = (event: DragEvent<HTMLElement>) => {
		if (
			!(event.relatedTarget instanceof Node) ||
			!event.currentTarget.contains(event.relatedTarget)
		) {
			setDrop(null);
		}
	};

	return { propsFor, classFor, onNavDragLeave };
};

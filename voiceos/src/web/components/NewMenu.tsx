// The top bar's "New": a plain session, a worktree to activate, or a machine's page — every way in
// from one place, with the page's menu manners (menu-keys.ts).
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { LOCAL_MACHINE } from '../../shared/machine-ref.js';
import { isMachineReachable, listMachineIds, readMachineTitle } from '../../shared/machines.js';
import type { State } from '../../shared/protocol.js';
import { describeCounts } from '../derive.js';
import { handleMenuKey, useClickOutside } from '../menu-keys.js';
import type { Dispatch } from '../types.js';
import { PlusIcon } from './icons.js';

interface NewMenuProps {
	state: State;
	dispatch: Dispatch;
	onNewSession: () => void;
}

export const NewMenu = ({ state, dispatch, onNewSession }: NewMenuProps) => {
	const [isOpen, setIsOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const buttonRef = useRef<HTMLButtonElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);

	const dismiss = useCallback(() => setIsOpen(false), []);

	useClickOutside(isOpen, wrapRef, dismiss);

	useEffect(() => {
		if (isOpen) {
			menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
		}
	}, [isOpen]);

	const close = () => {
		setIsOpen(false);
		buttonRef.current?.focus();
	};

	const pick = (run: () => void) => {
		setIsOpen(false);
		run();
	};

	const handleKey = (event: KeyboardEvent<HTMLDivElement>) =>
		handleMenuKey(event, { onEscape: close, onTab: dismiss });

	const openMachine = (machine?: string) =>
		dispatch({ type: 'switch_view', view: { kind: 'activate', ...(machine ? { machine } : {}) } });

	return (
		<div className="vo-newmenu" ref={wrapRef}>
			<button
				ref={buttonRef}
				type="button"
				className={`vo-new ${isOpen ? 'open' : ''}`}
				aria-haspopup="menu"
				aria-expanded={isOpen}
				onClick={() => setIsOpen((wasOpen) => !wasOpen)}
			>
				<PlusIcon />
				New
				<span aria-hidden="true" className="vo-new-caret">
					⌄
				</span>
			</button>
			{isOpen && (
				<div ref={menuRef} className="nm-menu" role="menu" aria-label="New" onKeyDown={handleKey}>
					<button
						type="button"
						role="menuitem"
						className="nm-item"
						onClick={() => pick(onNewSession)}
					>
						<span className="nm-ico" aria-hidden="true">
							<ChatIcon />
						</span>
						<span className="nm-text">
							New session
							<small>Plain Claude in any folder</small>
						</span>
					</button>
					<button
						type="button"
						role="menuitem"
						className="nm-item"
						onClick={() => pick(() => openMachine())}
					>
						<span className="nm-ico" aria-hidden="true">
							<BranchIcon />
						</span>
						<span className="nm-text">
							Activate a worktree
							<small>Give one a tab and its own Claude</small>
						</span>
					</button>
					<div className="nm-sep" />
					<div className="nm-cap" aria-hidden="true">
						Machines
					</div>
					{listMachineIds(state).map((id) => (
						<button
							key={id}
							type="button"
							role="menuitem"
							className="nm-item"
							data-machine={id}
							onClick={() => pick(() => openMachine(id))}
						>
							<span
								className={`dot ${id === LOCAL_MACHINE || isMachineReachable(state, id) ? 'ok' : 'ask'}`}
							/>
							<span className="nm-text">
								{readMachineTitle(state, id)}
								<small>{describeCounts(state, id)}</small>
							</span>
							<span className="nm-go" aria-hidden="true">
								›
							</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
};

const ICON = {
	width: 16,
	height: 16,
	viewBox: '0 0 16 16',
	fill: 'none',
	stroke: 'currentColor',
	strokeWidth: 1.5,
	strokeLinecap: 'round',
	strokeLinejoin: 'round',
	'aria-hidden': true,
} as const;

const ChatIcon = () => (
	<svg {...ICON}>
		<path d="M3 3.5h10a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H7.5L4.5 13.5V11H3a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" />
	</svg>
);

const BranchIcon = () => (
	<svg {...ICON}>
		<path d="M5 2.5v7M5 9.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM11 2.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM11 6.5c0 3-6 2-6 3" />
	</svg>
);

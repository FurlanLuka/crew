// Voice OS's top bar, docked: the crew mark (crew's Home), Voice OS's Home with its count, one tab per
// active session, "New" for every way in; on the right Discord, Claude usage, "voice" (off and on)
// and the settings gear, a labelled tab while Settings is open. The session tabs are the active set in
// its order: drag one, or Alt+← →, to move it.
import { type DragEvent, type KeyboardEvent, useState } from 'react';
import { listActiveRefs } from '../../shared/active.js';
import { machineOf } from '../../shared/machine-ref.js';
import { hasMachines, isNamed, readMachineName, readSessionLabel } from '../../shared/machines.js';
import type { State } from '../../shared/protocol.js';
import { describeSessionBadge, readRefTitle } from '../derive.js';
import type { Dispatch } from '../types.js';
import { NewMenu } from './NewMenu.js';
import { VoiceToggle } from './VoiceToggle.js';

interface TopBarProps {
	state: State;
	dispatch: Dispatch;
	onHome: () => void;
	onNewSession: () => void;
}

const GearIcon = () => (
	<svg
		width="15"
		height="15"
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.4"
		aria-hidden="true"
	>
		<circle cx="8" cy="8" r="2.2" />
		<path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
	</svg>
);

type DropSide = 'before' | 'after';

// Where a dragged tab lands: just before the tab it is over, or before the one after it. The dragged
// tab itself is never the anchor; null is the end.
export const readDropTarget = (
	refs: string[],
	dragged: string,
	over: string,
	side: DropSide,
): string | null => {
	if (side === 'before') {
		return over;
	}

	return refs.slice(refs.indexOf(over) + 1).find((ref) => ref !== dragged) ?? null;
};

// Alt+← / Alt+→: one place along; null when it is already at that end.
export const readKeyMove = (
	refs: string[],
	ref: string,
	step: -1 | 1,
): { before: string | null } | null => {
	const at = refs.indexOf(ref);

	if (at < 0 || (step < 0 && at === 0) || (step > 0 && at === refs.length - 1)) {
		return null;
	}

	return { before: step < 0 ? (refs[at - 1] ?? null) : (refs[at + 2] ?? null) };
};

export const TopBar = ({ state, dispatch, onHome, onNewSession }: TopBarProps) => {
	const { view } = state;
	const { sevenDay, fiveHour } = state.limits;
	const discord = state.discord?.isOwnerIn ? state.discord : null;
	const usage = [sevenDay, fiveHour].filter((value) => value !== null).map((value) => `${value}%`);
	// With other machines, the usage shown is this Mac's own Claude login.
	const usageOwner = hasMachines(state) ? 'This Mac’s ' : '';
	const activeRefs = listActiveRefs(state);
	const [dragged, setDragged] = useState<string | null>(null);
	const [drop, setDrop] = useState<{ ref: string; side: DropSide } | null>(null);

	const endDrag = () => {
		setDragged(null);
		setDrop(null);
	};

	const handleDragOver = (event: DragEvent<HTMLButtonElement>, ref: string) => {
		if (!dragged) {
			return;
		}

		// Back over itself nothing would move: no line promises otherwise.
		if (dragged === ref) {
			setDrop(null);

			return;
		}

		event.preventDefault();
		const rect = event.currentTarget.getBoundingClientRect();
		const side: DropSide = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';

		if (drop?.ref !== ref || drop.side !== side) {
			setDrop({ ref, side });
		}
	};

	const handleDrop = (event: DragEvent<HTMLButtonElement>) => {
		event.preventDefault();

		if (dragged && drop) {
			dispatch({
				type: 'move_active',
				ref: dragged,
				before: readDropTarget(activeRefs, dragged, drop.ref, drop.side),
			});
		}

		endDrag();
	};

	const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>, ref: string) => {
		if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) {
			return;
		}

		// Alt+← is the browser's Back elsewhere: here it moves the tab, and nothing else.
		event.preventDefault();
		const move = readKeyMove(activeRefs, ref, event.key === 'ArrowLeft' ? -1 : 1);

		if (move) {
			dispatch({ type: 'move_active', ref, before: move.before });
		}
	};
	const isSettings = view.kind === 'settings';

	return (
		<header className="vo-top">
			<button type="button" className="vo-brand" title="Home" onClick={onHome}>
				crew <span>voice os</span>
			</button>
			<nav
				className="vo-tabs"
				aria-label="Active sessions"
				onDragLeave={(event) => {
					if (
						!(event.relatedTarget instanceof Node) ||
						!event.currentTarget.contains(event.relatedTarget)
					) {
						setDrop(null);
					}
				}}
			>
				<button
					type="button"
					className="vo-tab"
					aria-current={view.kind === 'active'}
					onClick={() => dispatch({ type: 'switch_view', view: { kind: 'active' } })}
				>
					<b>Home</b>
					{activeRefs.length > 0 && <span className="vo-count">{activeRefs.length}</span>}
				</button>
				<span className="vo-sep" />
				{activeRefs.map((ref) => {
					const session = state.sessions[ref];

					if (!session) {
						return null;
					}

					const badge = describeSessionBadge(session, state.asks);
					// A name is chosen to stand alone: no machine beside it.
					const machine =
						machineOf(ref) && !isNamed(state, ref) ? readMachineName(state, ref) : null;

					return (
						<button
							type="button"
							key={ref}
							className={`vo-tab tab ${badge.isAlarm ? 'alarm' : ''} ${dragged === ref ? 'dragging' : ''} ${drop?.ref === ref ? `drop-${drop.side}` : ''}`}
							data-ref={ref}
							draggable
							aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
							onDragStart={(event) => {
								event.dataTransfer.effectAllowed = 'move';
								// Its own type, so a tab dropped on the text box never pastes its ref there.
								event.dataTransfer.setData('application/x-voiceos-ref', ref);
								setDragged(ref);
							}}
							onDragOver={(event) => handleDragOver(event, ref)}
							onDrop={handleDrop}
							onDragEnd={endDrag}
							onKeyDown={(event) => handleTabKey(event, ref)}
							aria-current={view.kind === 'session' && view.ref === ref}
							title={readRefTitle(state, ref) ?? `${badge.label}`}
							onClick={() => dispatch({ type: 'switch_view', view: { kind: 'session', ref } })}
						>
							<span className={`dot ${badge.dot}`} />
							{readSessionLabel(state, ref)}
							{machine && <small>{machine}</small>}
						</button>
					);
				})}
				<NewMenu state={state} dispatch={dispatch} onNewSession={onNewSession} />
			</nav>
			<div className="vo-right">
				{discord && (
					<span
						className="vo-discord"
						title={
							discord.isHearing
								? 'You are in the Discord voice channel: Voice OS hears and speaks there; this page shows and types.'
								: 'You are in the Discord voice channel, but Voice OS is not hearing you: pick a mode to try again.'
						}
					>
						<span className={`dot ${discord.isHearing ? 'ok' : 'ask'}`} />
						Voice via Discord · {discord.channelName}
						{discord.isHearing ? '' : ' · not hearing'}
					</span>
				)}
				{usage.length > 0 && (
					<span className="vo-usage" title={`${usageOwner}Claude usage: this week, 5-hour window`}>
						{usage.join(' · ')}
					</span>
				)}
				<VoiceToggle isOff={state.voiceOff} dispatch={dispatch} />
				{/* A quiet icon until Settings is open; then a labelled tab, like the page it is on. */}
				<button
					type="button"
					className={isSettings ? 'vo-tab vo-settings' : 'vo-gear'}
					aria-label="Voice OS settings"
					title="Voice OS settings"
					aria-current={isSettings}
					onClick={() => dispatch({ type: 'switch_view', view: { kind: 'settings' } })}
				>
					<GearIcon />
					{isSettings && <b>Settings</b>}
				</button>
			</div>
		</header>
	);
};

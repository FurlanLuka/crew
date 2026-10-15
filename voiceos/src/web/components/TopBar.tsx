// Voice OS's top bar, docked: the crew mark (crew's Home), Voice OS's Home with its count, one tab per
// active session or a chip per group of them, "New" for every way in; on the right Discord, Claude
// usage, "voice" (off and on) and the settings gear, a labelled tab while Settings is open. The tabs
// are the active set in its order: drag one, or Alt+← →, to move it; drop one on another to group
// them. An open group is the whole bar until ‹ closes it.
import { type KeyboardEvent, useCallback, useState } from 'react';
import { listActiveRefs } from '../../shared/active.js';
import {
	findGroup,
	layoutBar,
	nextGroupColor,
	readOpenGroup,
	suggestGroupName,
	type BarItem,
} from '../../shared/groups.js';
import { machineOf } from '../../shared/machine-ref.js';
import { hasMachines, isNamed, readMachineName, readSessionLabel } from '../../shared/machines.js';
import type { SessionGroup, State } from '../../shared/protocol.js';
import { describeGroup, describeSessionBadge, hasHiddenAlarm, readRefTitle } from '../derive.js';
import type { Dispatch } from '../types.js';
import { readMode } from '../../shared/modes.js';
import { type Spot, useMenuPress } from '../use-menu-press.js';
import { readItemKey, readKeyMove } from './bar-moves.js';
import { GroupBox, GroupChip } from './GroupChip.js';
import { GroupNamePopover } from './GroupNamePopover.js';
import { SkipBadge } from './ModeChip.js';
import { NewMenu } from './NewMenu.js';
import { GroupMenu, TabMenu } from './TabMenu.js';
import { type BarDragProps, useBarDrag } from './use-bar-drag.js';
import { VoiceToggle } from './VoiceToggle.js';
import { GearIcon } from './GearIcon.js';

interface TopBarProps {
	state: State;
	dispatch: Dispatch;
	onHome: () => void;
	onNewSession: () => void;
}

type BarMenuState =
	| { kind: 'tab'; ref: string; spot: Spot }
	| { kind: 'group'; id: string; spot: Spot };

type Naming =
	| { kind: 'create'; refs: [string, string]; spot: Spot }
	| { kind: 'rename'; id: string; spot: Spot };

// Under what was dropped on; the popover keeps itself on screen.
const spotUnder = (rect: DOMRect): Spot => ({ x: rect.left, y: rect.bottom + 8 });

// What the bar draws: everything, or with a group open, only that group's tabs.
export const readShownItems = (state: State): { items: BarItem[]; open: SessionGroup | null } => {
	const open = readOpenGroup(state);

	return open
		? { items: open.refs.map((ref) => ({ kind: 'session', ref })), open: open.group }
		: { items: layoutBar(state), open: null };
};

interface SessionTabProps {
	state: State;
	sessionRef: string;
	className: string;
	drag: BarDragProps;
	onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
	onOpen: () => void;
	onMenu: (spot: Spot) => void;
}

const SessionTab = ({
	state,
	sessionRef,
	className,
	drag,
	onKeyDown,
	onOpen,
	onMenu,
}: SessionTabProps) => {
	const press = useMenuPress(onMenu);
	const session = state.sessions[sessionRef];

	if (!session) {
		return null;
	}

	const badge = describeSessionBadge(session, state.asks);
	// A name is chosen to stand alone: no machine beside it.
	const machine =
		machineOf(sessionRef) && !isNamed(state, sessionRef)
			? readMachineName(state, sessionRef)
			: null;
	const { view } = state;

	return (
		<button
			type="button"
			className={`vo-tab tab ${badge.isAlarm ? 'alarm' : ''} ${className}`}
			data-ref={sessionRef}
			aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
			{...drag}
			{...press}
			onKeyDown={onKeyDown}
			aria-current={view.kind === 'session' && view.ref === sessionRef}
			title={readRefTitle(state, sessionRef) ?? `${badge.label}`}
			onClick={onOpen}
		>
			<span className={`dot ${badge.dot}`} />
			{readSessionLabel(state, sessionRef)}
			{machine && <small>{machine}</small>}
			{readMode(state, sessionRef) === 'skip' && <SkipBadge />}
		</button>
	);
};

export const TopBar = ({ state, dispatch, onHome, onNewSession }: TopBarProps) => {
	const { view } = state;
	const { sevenDay, fiveHour } = state.limits;
	const discord = state.discord?.isOwnerIn ? state.discord : null;
	const usage = [sevenDay, fiveHour].filter((value) => value !== null).map((value) => `${value}%`);
	// With other machines, the usage shown is this Mac's own Claude login.
	const usageOwner = hasMachines(state) ? 'This Mac’s ' : '';
	const activeCount = listActiveRefs(state).length;
	const { items, open } = readShownItems(state);
	const [menu, setMenu] = useState<BarMenuState | null>(null);
	const [naming, setNaming] = useState<Naming | null>(null);
	const closeMenu = useCallback(() => setMenu(null), []);
	const cancelNaming = useCallback(() => setNaming(null), []);

	const drag = useBarDrag({
		items,
		groups: state.groups,
		isOpenBox: open !== null,
		dispatch,
		onName: (target, dragged, anchor) =>
			setNaming({ kind: 'create', refs: [target, dragged], spot: spotUnder(anchor) }),
	});

	const handleKey = (event: KeyboardEvent<HTMLButtonElement>, item: BarItem) => {
		if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) {
			return;
		}

		// Alt+← is the browser's Back elsewhere: here it moves the tab, and nothing else.
		event.preventDefault();
		const move = readKeyMove(items, readItemKey(item), event.key === 'ArrowLeft' ? -1 : 1);

		if (!move) {
			return;
		}

		dispatch(
			item.kind === 'group'
				? { type: 'move_group', id: item.group.id, before: move.before }
				: { type: 'move_active', ref: item.ref, before: move.before },
		);
	};

	const renderTab = (item: Extract<BarItem, { kind: 'session' }>) => (
		<SessionTab
			key={item.ref}
			state={state}
			sessionRef={item.ref}
			className={drag.classFor(item)}
			drag={drag.propsFor(item)}
			onKeyDown={(event) => handleKey(event, item)}
			onOpen={() => dispatch({ type: 'switch_view', view: { kind: 'session', ref: item.ref } })}
			onMenu={(spot) => setMenu({ kind: 'tab', ref: item.ref, spot })}
		/>
	);

	const renderItem = (item: BarItem) => {
		if (item.kind === 'session') {
			return renderTab(item);
		}

		return (
			<GroupChip
				key={item.group.id}
				group={item.group}
				look={describeGroup(state, item.refs)}
				count={item.refs.length}
				dragClass={drag.classFor(item)}
				drag={drag.propsFor(item)}
				keyProps={{
					onKeyDown: (event) => handleKey(event, item),
					'aria-keyshortcuts': 'Alt+ArrowLeft Alt+ArrowRight',
				}}
				onOpen={() => dispatch({ type: 'open_group', id: item.group.id })}
				onMenu={(spot) => setMenu({ kind: 'group', id: item.group.id, spot })}
			/>
		);
	};

	const menuGroup = menu?.kind === 'group' ? findGroup(state.groups, menu.id) : null;
	const renamed = naming?.kind === 'rename' ? findGroup(state.groups, naming.id) : null;

	const isSettings = view.kind === 'settings';

	return (
		<header className="vo-top">
			<button type="button" className="vo-brand" title="Home" onClick={onHome}>
				crew <span>voice os</span>
			</button>
			<nav className="vo-tabs" aria-label="Active sessions" onDragLeave={drag.onNavDragLeave}>
				<button
					type="button"
					className="vo-tab"
					aria-current={view.kind === 'active'}
					onClick={() => dispatch({ type: 'switch_view', view: { kind: 'active' } })}
				>
					<b>Home</b>
					{activeCount > 0 && <span className="vo-count">{activeCount}</span>}
				</button>
				<span className="vo-sep" />
				{open ? (
					<GroupBox
						group={open}
						hasHiddenAlarm={hasHiddenAlarm(
							state,
							items.map((item) => readItemKey(item)),
						)}
						onClose={() => dispatch({ type: 'open_group', id: null })}
						onMenu={(spot) => setMenu({ kind: 'group', id: open.id, spot })}
					>
						{items.map(renderItem)}
					</GroupBox>
				) : (
					items.map(renderItem)
				)}
				<NewMenu state={state} dispatch={dispatch} onNewSession={onNewSession} />
			</nav>
			{menu?.kind === 'tab' && state.sessions[menu.ref] && (
				<TabMenu
					state={state}
					dispatch={dispatch}
					sessionRef={menu.ref}
					spot={menu.spot}
					onClose={closeMenu}
					onNewGroup={(partner) =>
						setNaming({ kind: 'create', refs: [partner, menu.ref], spot: menu.spot })
					}
				/>
			)}
			{menuGroup && menu && (
				<GroupMenu
					state={state}
					dispatch={dispatch}
					group={menuGroup}
					spot={menu.spot}
					onClose={closeMenu}
					onRename={() => setNaming({ kind: 'rename', id: menuGroup.id, spot: menu.spot })}
				/>
			)}
			{naming?.kind === 'create' && (
				<GroupNamePopover
					mode="create"
					spot={naming.spot}
					initialName={suggestGroupName(naming.refs)}
					initialColor={nextGroupColor(state.groups)}
					members={naming.refs.map((ref) => readSessionLabel(state, ref)).join(' + ')}
					onSubmit={(name, color) => {
						dispatch({ type: 'create_group', refs: naming.refs, name, color });
						setNaming(null);
					}}
					onCancel={cancelNaming}
				/>
			)}
			{renamed && naming && (
				<GroupNamePopover
					mode="rename"
					spot={naming.spot}
					initialName={renamed.name}
					onSubmit={(name) => {
						dispatch({ type: 'update_group', id: renamed.id, name });
						setNaming(null);
					}}
					onCancel={cancelNaming}
				/>
			)}
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

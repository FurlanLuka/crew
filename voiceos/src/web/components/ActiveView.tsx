// Home, where Voice OS opens: one row per active session, each with its own status, what waits on you
// first; beside them every machine, each a way into its page, and the words that do the same. A
// session that asked says so in its row and its tab's dot; there is no separate alert. With groups,
// each is its own list in its colour, in the bar's order, the loose sessions last.
import { useCallback, useState } from 'react';
import { isActive, listActiveMissing, listActiveRefs } from '../../shared/active.js';
import { findGroup, findGroupOf, layoutBar } from '../../shared/groups.js';
import { LOCAL_MACHINE, readMachine } from '../../shared/machine-ref.js';
import {
	isMachineReachable,
	listMachineIds,
	readMachineTitle,
	readSessionLabel,
} from '../../shared/machines.js';
import type { SessionGroup, State } from '../../shared/protocol.js';
import { readWorkLabel } from '../../shared/work-label.js';
import { describeWork } from '../../state/working.js';
import {
	describeCounts,
	describeMissingActive,
	describeSessionBadge,
	isWaiting,
	readLastLine,
	readRefTitle,
} from '../derive.js';
import type { Dispatch } from '../types.js';
import { useNow } from '../use-now.js';
import { countOf } from '../count.js';
import { type Spot, useMenuPress } from '../use-menu-press.js';
import { GroupNamePopover } from './GroupNamePopover.js';
import { PlusIcon } from './icons.js';
import { SkipBadge } from './ModeChip.js';
import { GroupMenu } from './TabMenu.js';
import { readMode } from '../../shared/modes.js';

interface ActiveViewProps {
	state: State;
	dispatch: Dispatch;
	onNewSession: () => void;
}

const CHIP_BY_DOT: Record<string, string> = {
	blocked: 'ask',
	needs: 'ask',
	running: 'run',
	starting: 'run',
};

export const countMachines = (refs: string[]): number =>
	new Set(refs.map((ref) => readMachine(ref))).size;

// Things to say that do what this page's buttons do.
const SAY_IT = [
	'“New session on Build box called logs”',
	'“Activate store main”',
	'“What’s waiting on me?”',
];

// What waits on you first; otherwise the developer's own order.
export const sortForHome = (state: State, refs: string[]): string[] => [
	...refs.filter((ref) => isWaiting(state, ref)),
	...refs.filter((ref) => !isWaiting(state, ref)),
];

export interface HomeSection {
	// null: the sessions in no group the bar draws.
	group: SessionGroup | null;
	refs: string[];
	// Active sessions not here (out of reach, gone): with their group when it is shown.
	missing: string[];
}

// Home's lists: each group the bar draws, in the bar's order, then the rest. Waiting first inside
// each, never across them, so a list stays where its chip is.
export const listHomeSections = (state: State): HomeSection[] => {
	const sections: HomeSection[] = [];
	const loose: string[] = [];

	for (const item of layoutBar(state)) {
		if (item.kind === 'group') {
			sections.push({ group: item.group, refs: sortForHome(state, item.refs), missing: [] });
		} else {
			loose.push(item.ref);
		}
	}

	const plain: HomeSection = { group: null, refs: sortForHome(state, loose), missing: [] };

	for (const ref of listActiveMissing(state)) {
		const group = findGroupOf(state.groups, ref);
		const shown = sections.find((section) => group && section.group?.id === group.id);

		(shown ?? plain).missing.push(ref);
	}

	return [...sections, plain].filter(
		(section) => section.refs.length > 0 || section.missing.length > 0,
	);
};

// "3 sessions · 2 need you"
export const describeSectionCount = (state: State, refs: string[]): string => {
	const waiting = refs.filter((ref) => isWaiting(state, ref)).length;
	const need = waiting === 0 ? '' : ` · ${countOf(waiting, 'needs', 'need')} you`;

	return `${countOf(refs.length, 'session')}${need}`;
};

interface RowProps {
	state: State;
	dispatch: Dispatch;
	sessionRef: string;
	now: number;
}

const SessionRow = ({ state, dispatch, sessionRef: ref, now }: RowProps) => {
	const session = state.sessions[ref];

	if (!session) {
		return null;
	}

	const badge = describeSessionBadge(session, state.asks);
	const work = describeWork(session, now);
	const age = work.waitingFor ?? work.for;
	const label = readSessionLabel(state, ref);
	const where = [
		session.label !== label ? session.label : '',
		readMachineTitle(state, readMachine(ref)),
	]
		.filter(Boolean)
		.join(' · ');
	const ask = state.asks.find((candidate) => candidate.ref === ref);
	const line =
		session.status === 'stopped' && session.error
			? 'Claude stopped unexpectedly · nothing you said was lost'
			: ask?.kind === 'question'
				? `Asks: ${ask.questions[0]?.question ?? ''}`
				: (session.needsUser?.text ?? readLastLine(session, label, isActive(state, ref)) ?? '');

	return (
		<button
			type="button"
			className={`box-row as-link vo-row ${badge.isAlarm ? 'waiting' : ''}`}
			data-ref={ref}
			title={readRefTitle(state, ref)}
			onClick={() => dispatch({ type: 'switch_view', view: { kind: 'session', ref } })}
		>
			<span className={`dot ${badge.dot}`} />
			<span className="sub">
				<b>{label}</b>
				{readMode(state, ref) === 'skip' && <SkipBadge />}
				<span className="m">{where}</span>
			</span>
			<span className="sub">
				{/* Waiting on you: what it asks leads, how long it has waited under it. */}
				<b className="topic">
					{badge.isAlarm && line ? line : (readWorkLabel(session) ?? 'Nothing asked yet')}
				</b>
				<span className="m">
					{badge.isAlarm && line
						? `Waiting on you${age ? ` · ${age}` : ''}`
						: line || 'Ready. Nothing sent yet.'}
				</span>
			</span>
			{badge.isAlarm ? (
				<span className="btn sm vo-answer">Answer</span>
			) : (
				<span className={`chip ${CHIP_BY_DOT[badge.dot] ?? ''}`}>
					{session.error && session.status === 'stopped' ? 'crashed' : badge.label}
					{age ? ` · ${age}` : ''}
				</span>
			)}
		</button>
	);
};

const MissingRow = ({ state, dispatch, sessionRef: ref }: Omit<RowProps, 'now'>) => (
	<div className="box-row vo-row missing" data-ref={ref}>
		<span className="dot ring" />
		<span className="sub">
			<b>{readSessionLabel(state, ref)}</b>
			<span className="m">{describeMissingActive(state, ref)}</span>
		</span>
		<span className="sub">
			<span className="m">Starts again when it's back.</span>
		</span>
		<button
			type="button"
			className="btn sm ghost"
			onClick={() => dispatch({ type: 'deactivate', ref })}
		>
			Deactivate
		</button>
	</div>
);

interface GroupHeadProps {
	state: State;
	group: SessionGroup;
	refs: string[];
	onOpen: () => void;
	onMenu: (spot: Spot) => void;
}

const GroupHead = ({ state, group, refs, onOpen, onMenu }: GroupHeadProps) => {
	const press = useMenuPress(onMenu);
	const isAlarm = refs.some((ref) => isWaiting(state, ref));

	return (
		<button
			type="button"
			className="vo-hgroup-head"
			title={`Open ${group.name}`}
			{...press}
			onClick={onOpen}
		>
			<span className="vo-hgroup-swatch" aria-hidden="true" />
			<b>{group.name}</b>
			<span className={`vo-hgroup-count ${isAlarm ? 'alarm' : ''}`}>
				{describeSectionCount(state, refs)}
			</span>
			<span className="vo-hgroup-open">Open group ›</span>
		</button>
	);
};

type HomeMenu =
	| { kind: 'menu'; id: string; spot: Spot }
	| { kind: 'rename'; id: string; spot: Spot };

export const ActiveView = ({ state, dispatch, onNewSession }: ActiveViewProps) => {
	const now = useNow();
	const refs = listActiveRefs(state);
	const sections = listHomeSections(state);
	const hasGroups = sections.some((section) => section.group);
	const total = refs.length;
	const machines = countMachines(refs);
	const [menu, setMenu] = useState<HomeMenu | null>(null);
	const closeMenu = useCallback(() => setMenu(null), []);

	const waiting = refs.filter((ref) => isWaiting(state, ref)).length;
	const menuGroup = menu ? findGroup(state.groups, menu.id) : null;
	const menuSection = sections.find((section) => section.group?.id === menu?.id);

	// Opening a group from Home also brings its first member on screen, waiting one first: the bar
	// alone changing would read as nothing happening.
	const openSection = (group: SessionGroup, members: string[]) => {
		dispatch({ type: 'open_group', id: group.id });
		const [first] = members;

		if (first) {
			dispatch({ type: 'switch_view', view: { kind: 'session', ref: first } });
		}
	};

	return (
		<section className="vo-view vo-home" aria-label="Home">
			<div className="vo-head">
				<div className="vo-head-text">
					<h1>Home</h1>
					<span className="vo-lead">
						{total === 0
							? 'Nothing active yet.'
							: `${countOf(total, 'session')} on ${countOf(machines, 'machine')}.${waiting > 0 ? ` ${waiting === 1 ? 'One needs' : `${waiting} need`} you.` : ''}`}
					</span>
				</div>
				<div className="row-actions">
					<button
						type="button"
						className="btn big"
						onClick={() => dispatch({ type: 'switch_view', view: { kind: 'activate' } })}
					>
						Activate a worktree
					</button>
					<button type="button" className="btn big primary" onClick={onNewSession}>
						<PlusIcon />
						New session
					</button>
				</div>
			</div>
			<div className="vo-home-body">
				<div className="vo-home-main">
					{sections.length === 0 ? (
						<div className="vo-empty">
							<b>Nothing active</b>
							<p>
								An active worktree has its own Claude and a tab up top. Pick the ones you're working
								on, or start a plain session in any folder.
							</p>
							<button
								type="button"
								className="btn primary"
								onClick={() => dispatch({ type: 'switch_view', view: { kind: 'activate' } })}
							>
								Activate a worktree
							</button>
						</div>
					) : (
						sections.map(({ group, refs: members, missing }) => (
							<section
								key={group?.id ?? 'plain'}
								className={`vo-hgroup ${group ? '' : 'plain'}`}
								data-group={group?.id}
								data-color={group?.color}
								aria-label={group?.name ?? (hasGroups ? 'Not in a group' : 'Sessions')}
							>
								{group ? (
									<GroupHead
										state={state}
										group={group}
										refs={members}
										onOpen={() => openSection(group, members)}
										onMenu={(spot) => setMenu({ kind: 'menu', id: group.id, spot })}
									/>
								) : (
									hasGroups && (
										<div className="vo-hgroup-head">
											<b>Not in a group</b>
											<span className="vo-hgroup-count">
												{describeSectionCount(state, members)}
											</span>
										</div>
									)
								)}
								<div className="box vo-list">
									{members.map((ref) => (
										<SessionRow
											key={ref}
											state={state}
											dispatch={dispatch}
											sessionRef={ref}
											now={now}
										/>
									))}
									{missing.map((ref) => (
										<MissingRow key={ref} state={state} dispatch={dispatch} sessionRef={ref} />
									))}
								</div>
							</section>
						))
					)}
				</div>
				<aside className="vo-home-side">
					<section className="vo-machines" aria-label="Machines">
						<h2>Machines</h2>
						{listMachineIds(state).map((id) => {
							const isLocal = id === LOCAL_MACHINE;
							const isUp = isLocal || isMachineReachable(state, id);

							return (
								<button
									type="button"
									key={id}
									className="vo-machine-card"
									data-machine={id}
									onClick={() =>
										dispatch({ type: 'switch_view', view: { kind: 'activate', machine: id } })
									}
								>
									<span className="vo-machine-top">
										<span className={`dot ${isUp ? 'ok' : 'ask'}`} />
										<b>{readMachineTitle(state, id)}</b>
										{isLocal ? (
											<span className="chip ok">main</span>
										) : (
											<span className="vo-host">{state.machines[id]?.host}</span>
										)}
									</span>
									<span className="vo-machine-counts">
										{isUp
											? describeCounts(state, id)
											: (state.machines[id]?.detail ?? 'not reachable')}
									</span>
								</button>
							);
						})}
					</section>
					<section className="vo-say" aria-label="Or just say it">
						<h2>Or just say it</h2>
						{SAY_IT.map((line) => (
							<p key={line}>{line}</p>
						))}
					</section>
				</aside>
			</div>
			{menu?.kind === 'menu' && menuGroup && (
				<GroupMenu
					state={state}
					dispatch={dispatch}
					group={menuGroup}
					spot={menu.spot}
					onClose={closeMenu}
					onOpen={() => openSection(menuGroup, menuSection?.refs ?? [])}
					onRename={() => setMenu({ kind: 'rename', id: menuGroup.id, spot: menu.spot })}
				/>
			)}
			{menu?.kind === 'rename' && menuGroup && (
				<GroupNamePopover
					mode="rename"
					spot={menu.spot}
					initialName={menuGroup.name}
					onSubmit={(name) => {
						dispatch({ type: 'update_group', id: menuGroup.id, name });
						closeMenu();
					}}
					onCancel={closeMenu}
				/>
			)}
		</section>
	);
};

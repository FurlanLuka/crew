// A machine's page (or every machine's): its plain sessions, then its worktrees grouped by workspace.
// Activating starts its Claude: it gets a tab and a row on Home, with no page change. Worktrees are
// made in Set up; a plain session is made from here, in the New session dialog.
import { useState } from 'react';
import { countMachineRefs, isActive, listVoiceRefsOn } from '../../shared/active.js';
import { CHAT_WORKSPACE, isChatRef, LOCAL_MACHINE, splitRef } from '../../shared/machine-ref.js';
import {
	isMachineReachable,
	isNamed,
	listMachineIds,
	readMachineTitle,
	readSessionLabel,
} from '../../shared/machines.js';
import type { State } from '../../shared/protocol.js';
import { readWorkLabel } from '../../shared/work-label.js';
import { describeSessionBadge } from '../derive.js';
import { countOf } from '../count.js';
import type { Dispatch } from '../types.js';

// A row's title: a session's name, a plain session's label (it has no worktree), else the worktree.
const readRowTitle = (state: State, ref: string): string =>
	isNamed(state, ref) || isChatRef(ref)
		? readSessionLabel(state, ref)
		: splitRef(ref).worktree || ref;

// The heading a workspace group shows: plain sessions are not a workspace called chat.
export const describeGroup = (workspace: string): string =>
	workspace === CHAT_WORKSPACE ? 'Plain sessions' : workspace;

interface ActivateProps {
	state: State;
	dispatch: Dispatch;
	// The machine the view opened on; none for every machine.
	machine?: string;
	onNewSession: (machine: string) => void;
	onSetUpMachine: (machine: string) => void;
}

interface WorkspaceGroup {
	workspace: string;
	refs: string[];
}

export interface MachineSection {
	id: string;
	title: string;
	isOffline: boolean;
	status: string;
	groups: WorkspaceGroup[];
}

const matches = (state: State, ref: string, query: string): boolean => {
	if (!query) {
		return true;
	}

	const session = state.sessions[ref];
	const text = `${splitRef(ref).local} ${readSessionLabel(state, ref)} ${session ? (readWorkLabel(session) ?? '') : ''}`;

	return text.toLowerCase().includes(query.toLowerCase());
};

// Pure: the sections Activate shows for a filter and a search.
export const listActivateSections = (
	state: State,
	filter: string,
	query: string,
): MachineSection[] =>
	listMachineIds(state)
		.filter((id) => filter === 'all' || filter === id)
		.flatMap((id): MachineSection[] => {
			const all = listVoiceRefsOn(state, id);
			const shown = all.filter((ref) => matches(state, ref, query));

			if (query && shown.length === 0) {
				return [];
			}

			const groups: WorkspaceGroup[] = [];

			for (const ref of shown) {
				const { workspace } = splitRef(ref);
				const group = groups.find((candidate) => candidate.workspace === workspace);

				if (group) {
					group.refs.push(ref);
				} else {
					groups.push({ workspace, refs: [ref] });
				}
			}

			const isOffline = id !== LOCAL_MACHINE && !isMachineReachable(state, id);
			const activeCount = countMachineRefs(state, id).active;
			const status = isOffline
				? (state.machines[id]?.detail ?? 'not reachable')
				: `${activeCount} of ${all.length} active`;

			return [{ id, title: readMachineTitle(state, id), isOffline, status, groups }];
		});

const MACHINE_WORDS = {
	connecting: 'connecting',
	syncing: 'catching up',
	connected: 'connected',
	unreachable: 'not reachable',
	error: 'needs a fix',
} as const;

interface RowsProps {
	state: State;
	dispatch: Dispatch;
	section: MachineSection;
	refs: string[];
}

// One workspace's rows (or the plain sessions'): an active one opens, any other activates.
const Rows = ({ state, dispatch, section, refs }: RowsProps) => (
	<>
		{refs.map((ref) => {
			const session = state.sessions[ref];
			const topic = session ? (readWorkLabel(session) ?? 'not started') : '';

			if (session && isActive(state, ref)) {
				const badge = describeSessionBadge(session, state.asks);

				return (
					<div key={ref} className="box-row vb-row" data-ref={ref}>
						<span className={`dot ${badge.dot}`} />
						<span className="sub">
							<b>{readRowTitle(state, ref)}</b>
							<span className="m">{isChatRef(ref) ? session.cwd : topic}</span>
						</span>
						<span className="row-actions">
							<span className="chip ok">active</span>
							<button
								type="button"
								className="btn"
								onClick={() => dispatch({ type: 'switch_view', view: { kind: 'session', ref } })}
							>
								Open
							</button>
						</span>
					</div>
				);
			}

			const waiting = session?.queue[0];

			return (
				<div key={ref} className="box-row vb-row" data-ref={ref}>
					<span className="dot" />
					<span className="sub">
						<b>{readRowTitle(state, ref)}</b>
						<span className="m">
							{waiting
								? `${session?.queue.length ?? 1} waiting: “${waiting.text}”`
								: isChatRef(ref)
									? (session?.cwd ?? '')
									: topic}
						</span>
					</span>
					<button
						type="button"
						className="btn"
						disabled={section.isOffline}
						title={section.isOffline ? `Comes back when ${section.title} is reachable` : undefined}
						onClick={() => dispatch({ type: 'activate', ref })}
					>
						Activate
					</button>
				</div>
			);
		})}
	</>
);

export const Activate = ({
	state,
	dispatch,
	machine,
	onNewSession,
	onSetUpMachine,
}: ActivateProps) => {
	const [query, setQuery] = useState('');
	// The view carries the machine, so every tab shows the same one and New knows where it is.
	const filter = machine ?? 'all';
	const sections = listActivateSections(state, filter, query.trim());
	const machineIds = listMachineIds(state);
	const one = filter === 'all' ? null : filter;
	const oneConfig = one && one !== LOCAL_MACHINE ? state.machines[one] : undefined;
	const isOneUp = one === LOCAL_MACHINE || (one !== null && isMachineReachable(state, one));

	return (
		<section className="vo-view vo-machine-page" aria-label="Machines">
			{machineIds.length > 1 && (
				<div className="seg vb-switch">
					{['all', ...machineIds].map((id) => (
						<button
							key={id}
							type="button"
							aria-pressed={filter === id}
							onClick={() =>
								dispatch({
									type: 'switch_view',
									view: { kind: 'activate', ...(id === 'all' ? {} : { machine: id }) },
								})
							}
						>
							{id === 'all' ? (
								'All machines'
							) : (
								<>
									<span
										className={`dot ${id === LOCAL_MACHINE || isMachineReachable(state, id) ? 'ok' : 'ask'}`}
									/>
									{readMachineTitle(state, id)}
								</>
							)}
						</button>
					))}
				</div>
			)}
			<div className="vo-head">
				<div className="vo-head-text">
					<h1>
						{one ? readMachineTitle(state, one) : 'All machines'}
						{one && (
							<span className={`chip ${isOneUp ? 'ok' : 'ask'}`}>
								{one === LOCAL_MACHINE
									? 'main'
									: oneConfig
										? MACHINE_WORDS[oneConfig.status]
										: 'unknown'}
							</span>
						)}
					</h1>
					<span className="vo-lead">
						{one === LOCAL_MACHINE
							? 'Here · runs crew’s server'
							: oneConfig
								? `${oneConfig.host}${oneConfig.detail ? ` · ${oneConfig.detail}` : ''}`
								: 'Every worktree and plain session. An active one gets a tab and its own Claude.'}
					</span>
				</div>
				{one && (
					<div className="row-actions">
						{one !== LOCAL_MACHINE && (
							<button type="button" className="btn big" onClick={() => onSetUpMachine(one)}>
								Open in Set up
							</button>
						)}
						<button
							type="button"
							className="btn big primary"
							disabled={!isOneUp}
							onClick={() => onNewSession(one)}
						>
							New session on {readMachineTitle(state, one)}
						</button>
					</div>
				)}
			</div>
			<div className="vb-filter">
				<input
					type="search"
					placeholder="Find a session or worktree"
					aria-label="Find a worktree or topic"
					autoComplete="off"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
			</div>
			<div className="vo-lib vb-lib">
				{sections.length === 0 && (
					<p className="vb-empty">No worktree matches. Worktrees are made in Set up.</p>
				)}
				{sections.map((section) => {
					const plain = section.groups.find((group) => group.workspace === CHAT_WORKSPACE);
					const workspaces = section.groups.filter((group) => group.workspace !== CHAT_WORKSPACE);

					return (
						<div key={section.id} className={`vb-sec ${section.isOffline ? 'off' : ''}`}>
							{one === null && (
								<div className="vb-machine">
									<span className={`dot ${section.isOffline ? 'ask' : 'ok'}`} />
									<b>{section.title}</b>
									<span className="m">{section.status}</span>
									<button
										type="button"
										className="btn"
										disabled={section.isOffline}
										onClick={() => onNewSession(section.id)}
									>
										New session
									</button>
								</div>
							)}
							<div className="ws">
								<div className="ws-h-row">
									<b>{describeGroup(CHAT_WORKSPACE)}</b>
									<span className="m">Claude in a folder, no worktree</span>
								</div>
								<div className="box">
									{plain && (
										<Rows state={state} dispatch={dispatch} section={section} refs={plain.refs} />
									)}
									<div className="box-row vb-row vb-start">
										<span />
										<span className="sub">
											<span className="m">
												Start {plain ? 'another' : 'one'} in any folder on {section.title}.
											</span>
										</span>
										<button
											type="button"
											className="btn"
											disabled={section.isOffline}
											onClick={() => onNewSession(section.id)}
										>
											New session
										</button>
									</div>
								</div>
							</div>
							{workspaces.length === 0 && (
								<p className="vb-empty">No worktrees here yet. Worktrees are made in Set up.</p>
							)}
							{workspaces.map((group) => (
								<div key={group.workspace} className="ws">
									<div className="ws-h-row">
										<b>{group.workspace}</b>
										<span className="m">{countOf(group.refs.length, 'worktree')}</span>
									</div>
									<div className="box">
										<Rows state={state} dispatch={dispatch} section={section} refs={group.refs} />
									</div>
								</div>
							))}
						</div>
					);
				})}
			</div>
		</section>
	);
};

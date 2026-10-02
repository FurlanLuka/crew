// "+": every worktree on every machine, grouped by machine then workspace. Activating starts its
// Claude: it gets a tab and a row in Active, with no page change. Worktrees are made in Set up.
import { useState } from 'react';
import { isActive, listVoiceRefsOn } from '../../shared/active.js';
import { LOCAL_MACHINE, splitRef } from '../../shared/machine-ref.js';
import {
	isMachineReachable,
	isNamed,
	readMachineTitle,
	readSessionLabel,
} from '../../shared/machines.js';
import type { State } from '../../shared/protocol.js';
import { readWorkLabel } from '../../shared/work-label.js';
import { describeSessionBadge } from '../derive.js';
import type { Dispatch } from '../types.js';

interface ActivateProps {
	state: State;
	dispatch: Dispatch;
	// The machine the view opened on; none for every machine.
	machine?: string;
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

const listMachineIds = (state: State): string[] => [LOCAL_MACHINE, ...Object.keys(state.machines)];

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
			const activeCount = all.filter((ref) => isActive(state, ref)).length;
			const status = isOffline
				? (state.machines[id]?.detail ?? 'not reachable')
				: `${activeCount} of ${all.length} active`;

			return [{ id, title: readMachineTitle(state, id), isOffline, status, groups }];
		});

export const Activate = ({ state, dispatch, machine }: ActivateProps) => {
	const [query, setQuery] = useState('');
	const [filter, setFilter] = useState(machine ?? 'all');
	const sections = listActivateSections(state, filter, query.trim());
	const machineIds = listMachineIds(state);

	return (
		<section className="vo-view" aria-label="Activate">
			<div className="vo-head">
				<h1>Activate</h1>
				<span className="m">
					every worktree on your machines · an active one gets a tab and its own Claude
				</span>
			</div>
			<div className="vb-filter">
				<input
					type="search"
					placeholder="Find a worktree or topic"
					aria-label="Find a worktree or topic"
					autoComplete="off"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
				{machineIds.length > 1 && (
					<div className="seg" role="tablist" aria-label="Machine">
						{['all', ...machineIds].map((id) => (
							<button
								key={id}
								type="button"
								role="tab"
								aria-selected={filter === id}
								onClick={() => setFilter(id)}
							>
								{id === 'all' ? (
									'All machines'
								) : (
									<>
										<span
											className={`dot ${id === LOCAL_MACHINE || isMachineReachable(state, id) ? 'ok' : ''}`}
										/>
										{readMachineTitle(state, id)}
									</>
								)}
							</button>
						))}
					</div>
				)}
			</div>
			<div className="vo-lib vb-lib">
				{sections.length === 0 && (
					<p className="vb-empty">No worktree matches. Worktrees are made in Set up.</p>
				)}
				{sections.map((section) => (
					<div key={section.id} className={`vb-sec ${section.isOffline ? 'off' : ''}`}>
						<div className="vb-machine">
							<span className={`dot ${section.isOffline ? 'ask' : 'ok'}`} />
							<b>{section.title}</b>
							<span className="m">{section.status}</span>
						</div>
						{section.groups.length === 0 && (
							<p className="vb-empty">No worktrees here yet. Worktrees are made in Set up.</p>
						)}
						{section.groups.map((group) => (
							<div key={group.workspace} className="ws">
								<div className="ws-h-row">
									<b>{group.workspace}</b>
								</div>
								<div className="box">
									{group.refs.map((ref) => {
										const session = state.sessions[ref];
										const { worktree } = splitRef(ref);
										const topic = session ? (readWorkLabel(session) ?? 'not started') : '';

										if (session && isActive(state, ref)) {
											const badge = describeSessionBadge(session, state.asks);

											return (
												<button
													type="button"
													key={ref}
													className="box-row as-link"
													data-ref={ref}
													onClick={() =>
														dispatch({ type: 'switch_view', view: { kind: 'session', ref } })
													}
												>
													<span className={`dot ${badge.dot}`} />
													<span className="sub">
														<b>{isNamed(state, ref) ? readSessionLabel(state, ref) : worktree}</b>
														<span className="m">{topic}</span>
													</span>
													<span className="chip ok">active</span>
												</button>
											);
										}

										const waiting = session?.queue[0];

										return (
											<div key={ref} className="box-row" data-ref={ref}>
												<span className="dot" />
												<span className="sub">
													<b>{worktree || ref}</b>
													<span className="m">
														{waiting
															? `${session?.queue.length ?? 1} waiting: “${waiting.text}”`
															: topic}
													</span>
												</span>
												<button
													type="button"
													className="btn sm"
													disabled={section.isOffline}
													title={
														section.isOffline
															? `Comes back when ${section.title} is reachable`
															: undefined
													}
													onClick={() => dispatch({ type: 'activate', ref })}
												>
													Activate
												</button>
											</div>
										);
									})}
								</div>
							</div>
						))}
					</div>
				))}
			</div>
		</section>
	);
};

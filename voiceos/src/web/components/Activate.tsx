// "+": every worktree on every machine, grouped by machine then workspace, and the plain sessions
// beside them. Activating starts its Claude: it gets a tab and a row in Active, with no page change.
// Worktrees are made in Set up; a plain session is made here (crew chat add on that machine).
import { type FormEvent, useState } from 'react';
import { isActive, listVoiceRefsOn } from '../../shared/active.js';
import {
	CHAT_WORKSPACE,
	isChatRef,
	LOCAL_MACHINE,
	refOn,
	splitRef,
} from '../../shared/machine-ref.js';
import {
	isMachineReachable,
	isNamed,
	readMachineTitle,
	readSessionLabel,
} from '../../shared/machines.js';
import type { State } from '../../shared/protocol.js';
import { readWorkLabel } from '../../shared/work-label.js';
import { describeSessionBadge } from '../derive.js';
import { isOk, readCrewLine, runCrew } from '../setup/api.js';
import { findNamedRef, MAX_NAME_LENGTH } from '../../state/names.js';
import type { Dispatch } from '../types.js';

// A row's title: a session's name, a plain session's label (it has no worktree), else the worktree.
const readRowTitle = (state: State, ref: string): string =>
	isNamed(state, ref) || isChatRef(ref)
		? readSessionLabel(state, ref)
		: splitRef(ref).worktree || ref;

// The heading a workspace group shows: plain sessions are not a workspace called chat.
export const describeGroup = (workspace: string): string =>
	workspace === CHAT_WORKSPACE ? 'Plain sessions' : workspace;

interface NewSessionProps {
	state: State;
	machine: string;
	title: string;
	dispatch: Dispatch;
	onDone: (line: string) => void;
}

// A plain Claude session on this machine: a folder there (home when empty) and a name. Made with crew
// on that machine, then activated: it starts as soon as it is listed.
const NewSession = ({ state, machine, title, dispatch, onDone }: NewSessionProps) => {
	const [dir, setDir] = useState('');
	const [name, setName] = useState('');
	const [line, setLine] = useState<string | null>(null);
	const [isBusy, setIsBusy] = useState(false);

	const start = async (event: FormEvent) => {
		event.preventDefault();

		// Two sessions under one name would leave "ask research" guessing.
		if (name.trim() && findNamedRef(state, name.trim())) {
			setLine(`A session is already called ${name.trim()}.`);

			return;
		}

		setIsBusy(true);
		const reply = await runCrew(machine, {
			type: 'chat_add',
			...(dir.trim() ? { dir: dir.trim() } : {}),
			...(name.trim() ? { name: name.trim() } : {}),
		});
		setIsBusy(false);
		const added =
			isOk(reply) && 'json' in reply ? (reply.json as { id?: string } | undefined) : undefined;

		if (!added?.id) {
			setLine(readCrewLine(reply) || 'Not started.');

			return;
		}

		dispatch({ type: 'activate', ref: refOn(machine, `${CHAT_WORKSPACE}/${added.id}`) });
		onDone(`Started ${name.trim() || 'a plain session'} on ${title}.`);
	};

	return (
		<form
			className="vb-new"
			aria-label={`New session on ${title}`}
			onSubmit={(event) => void start(event)}
		>
			<label className="field">
				<span>Folder</span>
				<input
					type="text"
					autoComplete="off"
					placeholder="home folder"
					value={dir}
					onChange={(event) => setDir(event.target.value)}
				/>
			</label>
			<label className="field">
				<span>Name</span>
				<input
					type="text"
					autoComplete="off"
					placeholder="what you call it aloud"
					maxLength={MAX_NAME_LENGTH}
					value={name}
					onChange={(event) => setName(event.target.value)}
				/>
			</label>
			<div className="row-actions">
				<button type="submit" className="btn sm primary" disabled={isBusy}>
					Start
				</button>
				<button type="button" className="btn sm ghost" onClick={() => onDone('')}>
					Cancel
				</button>
			</div>
			{line && <p className="vs-note">{line}</p>}
		</form>
	);
};

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
	// The machine whose New session form is open, and the line the last one left.
	const [newOn, setNewOn] = useState<string | null>(null);
	const [newLine, setNewLine] = useState<string | null>(null);
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
							<button
								type="button"
								className="btn sm ghost"
								disabled={section.isOffline}
								onClick={() => {
									setNewLine(null);
									setNewOn(section.id);
								}}
							>
								New session
							</button>
						</div>
						{newOn === section.id && (
							<NewSession
								state={state}
								machine={section.id}
								title={section.title}
								dispatch={dispatch}
								onDone={(line) => {
									setNewOn(null);
									setNewLine(line || null);
								}}
							/>
						)}
						{newLine && newOn === null && <p className="vs-note">{newLine}</p>}
						{section.groups.length === 0 && (
							<p className="vb-empty">No worktrees here yet. Worktrees are made in Set up.</p>
						)}
						{section.groups.map((group) => (
							<div key={group.workspace} className="ws">
								<div className="ws-h-row">
									<b>{describeGroup(group.workspace)}</b>
								</div>
								<div className="box">
									{group.refs.map((ref) => {
										const session = state.sessions[ref];
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
														<b>{readRowTitle(state, ref)}</b>
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
													<b>{readRowTitle(state, ref)}</b>
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

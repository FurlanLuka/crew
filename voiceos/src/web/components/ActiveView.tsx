// Home, where Voice OS opens: one row per active session, each with its own status, what waits on you
// first; beside them every machine, each a way into its page, and the words that do the same. A
// session that asked says so in its row and its tab's dot; there is no separate alert.
import { isActive, listActiveMissing, listActiveRefs } from '../../shared/active.js';
import { LOCAL_MACHINE, readMachine } from '../../shared/machine-ref.js';
import {
	isMachineReachable,
	listMachineIds,
	readMachineTitle,
	readSessionLabel,
} from '../../shared/machines.js';
import type { State } from '../../shared/protocol.js';
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
import { PlusIcon } from './icons.js';
import { SkipBadge } from './ModeChip.js';
import { readMode } from '../../state/session-modes.js';

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
	'“Activate signals main”',
	'“What’s waiting on me?”',
];

// What waits on you first; otherwise the developer's own order.
export const sortForHome = (state: State, refs: string[]): string[] => [
	...refs.filter((ref) => isWaiting(state, ref)),
	...refs.filter((ref) => !isWaiting(state, ref)),
];

export const ActiveView = ({ state, dispatch, onNewSession }: ActiveViewProps) => {
	const now = useNow();
	const refs = sortForHome(state, listActiveRefs(state));
	const missing = listActiveMissing(state);
	const total = refs.length;
	const machines = countMachines(refs);

	const waiting = refs.filter((ref) => isWaiting(state, ref)).length;

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
					{total === 0 && missing.length === 0 ? (
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
						<div className="box vo-list">
							{refs.map((ref) => {
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
											: (session.needsUser?.text ??
												readLastLine(session, label, isActive(state, ref)) ??
												'');

								return (
									<button
										type="button"
										key={ref}
										className={`box-row as-link vo-row ${badge.isAlarm ? 'waiting' : ''}`}
										data-ref={ref}
										title={readRefTitle(state, ref)}
										onClick={() =>
											dispatch({ type: 'switch_view', view: { kind: 'session', ref } })
										}
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
												{badge.isAlarm && line
													? line
													: (readWorkLabel(session) ?? 'Nothing asked yet')}
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
							})}
							{missing.map((ref) => (
								<div key={ref} className="box-row vo-row missing" data-ref={ref}>
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
							))}
						</div>
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
		</section>
	);
};

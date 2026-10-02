// Where Voice OS opens: one row per active session, each with its own status. A session that asked
// says so in its row and its tab's dot; there is no separate alert.
import { isActive, listActiveMissing, listActiveRefs } from '../../shared/active.js';
import { readMachine } from '../../shared/machine-ref.js';
import { readMachineTitle, readSessionLabel } from '../../shared/machines.js';
import type { State } from '../../shared/protocol.js';
import { readWorkLabel } from '../../shared/work-label.js';
import { describeWork } from '../../state/working.js';
import {
	describeMissingActive,
	describeSessionBadge,
	readLastLine,
	readRefTitle,
} from '../derive.js';
import type { Dispatch } from '../types.js';
import { useNow } from '../use-now.js';
import { countOf } from '../count.js';

interface ActiveViewProps {
	state: State;
	dispatch: Dispatch;
}

const CHIP_BY_DOT: Record<string, string> = {
	blocked: 'ask',
	needs: 'ask',
	running: 'run',
	starting: 'run',
};

export const countMachines = (refs: string[]): number =>
	new Set(refs.map((ref) => readMachine(ref))).size;

export const ActiveView = ({ state, dispatch }: ActiveViewProps) => {
	const now = useNow();
	const refs = listActiveRefs(state);
	const missing = listActiveMissing(state);
	const total = refs.length;
	const machines = countMachines(refs);

	return (
		<section className="vo-view" aria-label="Active">
			<div className="vo-head">
				<h1>Active</h1>
				<span className="m">
					{total === 0
						? 'nothing active'
						: `${countOf(total, 'session')} on ${countOf(machines, 'machine')}`}
				</span>
			</div>
			{total === 0 && missing.length === 0 ? (
				<div className="vo-empty">
					<b>Nothing active</b>
					<p>
						An active worktree has its own Claude and a tab up top. Pick the ones you're working on.
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
								className="box-row as-link vo-row"
								data-ref={ref}
								title={readRefTitle(state, ref)}
								onClick={() => dispatch({ type: 'switch_view', view: { kind: 'session', ref } })}
							>
								<span className={`dot ${badge.dot}`} />
								<span className="sub">
									<b>{label}</b>
									<span className="m">{where}</span>
								</span>
								<span className="sub">
									<b className="topic">{readWorkLabel(session) ?? 'Nothing asked yet'}</b>
									<span className="m">{line || 'Ready. Nothing sent yet.'}</span>
								</span>
								<span className={`chip ${CHIP_BY_DOT[badge.dot] ?? ''}`}>
									{session.error && session.status === 'stopped' ? 'crashed' : badge.label}
									{age ? ` · ${age}` : ''}
								</span>
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
		</section>
	);
};

import type { PendingAsk } from '../../shared/protocol.js';
import type { Dispatch } from '../types.js';
import { QuestionDock } from './QuestionDock.js';
import { Reason } from './Reason.js';

interface AskDockProps {
	ask: PendingAsk;
	label: string;
	dispatch: Dispatch;
}

export const AskDock = ({ ask, label, dispatch }: AskDockProps) => {
	if (ask.kind === 'permission') {
		const command = typeof ask.input.command === 'string' ? ask.input.command : null;

		return (
			<section className="dock crit" aria-label="permission">
				<span className="lbl c-crit">
					permission · {label} · {ask.toolName}
				</span>
				<div className="ask">
					{label} wants to {ask.summary}.
				</div>
				{command && <div className="cmd">{command}</div>}
				<div className="btns">
					<button
						type="button"
						className="btn primary"
						onClick={() =>
							dispatch({ type: 'answer_permission', askId: ask.id, decision: 'allow' })
						}
					>
						Yes · “yes”
					</button>
					{ask.suggestions.length > 0 && (
						<button
							type="button"
							className="btn"
							onClick={() =>
								dispatch({ type: 'answer_permission', askId: ask.id, decision: 'always' })
							}
						>
							Always for this · “always”
						</button>
					)}
					<button
						type="button"
						className="btn danger"
						onClick={() => dispatch({ type: 'answer_permission', askId: ask.id, decision: 'deny' })}
					>
						No · “no”
					</button>
				</div>
				<Reason
					label="No, and tell it why…"
					onSubmit={(message) =>
						dispatch({ type: 'answer_permission', askId: ask.id, decision: 'deny', message })
					}
				/>
			</section>
		);
	}

	if (ask.kind === 'plan') {
		return (
			<section className="dock amber" aria-label="plan">
				<span className="lbl c-amber">plan ready · {label}</span>
				<div className="quote">{ask.plan}</div>
				<div className="btns">
					<button
						type="button"
						className="btn primary"
						onClick={() => dispatch({ type: 'answer_plan', askId: ask.id, isApproved: true })}
					>
						Approve · “approve”
					</button>
				</div>
				<Reason
					label="Change the plan…"
					onSubmit={(message) =>
						dispatch({ type: 'answer_plan', askId: ask.id, isApproved: false, message })
					}
				/>
			</section>
		);
	}

	return <QuestionDock ask={ask} label={label} dispatch={dispatch} />;
};

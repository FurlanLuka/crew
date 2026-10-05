import { isSetupRef } from '../../shared/machine-ref.js';
import type { PendingAsk } from '../../shared/protocol.js';
import type { Dispatch } from '../types.js';
import { Markdown } from './Markdown.js';
import { QuestionDock } from './QuestionDock.js';
import { Reason } from './Reason.js';

interface AskDockProps {
	ask: PendingAsk;
	label: string;
	dispatch: Dispatch;
}

// The word that answers by voice, beside its button. A setup session's asks are answered in Set up's
// chat and never heard, so they show no words to say.
export const describeSaid = (ask: PendingAsk, word: string): string =>
	isSetupRef(ask.ref) ? '' : ` · “${word}”`;

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
						Yes{describeSaid(ask, 'yes')}
					</button>
					{ask.suggestions.length > 0 && (
						<button
							type="button"
							className="btn"
							onClick={() =>
								dispatch({ type: 'answer_permission', askId: ask.id, decision: 'always' })
							}
						>
							Always for this{describeSaid(ask, 'always')}
						</button>
					)}
					<button
						type="button"
						className="btn danger"
						onClick={() => dispatch({ type: 'answer_permission', askId: ask.id, decision: 'deny' })}
					>
						No{describeSaid(ask, 'no')}
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
			<section className="dock amber plan" aria-label="plan">
				<span className="lbl c-amber">plan ready · {label}</span>
				<div className="quote">
					<Markdown text={ask.plan} />
				</div>
				<div className="btns">
					<button
						type="button"
						className="btn primary"
						onClick={() => dispatch({ type: 'answer_plan', askId: ask.id, isApproved: true })}
					>
						Approve{describeSaid(ask, 'approve')}
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

	if (ask.kind === 'command') {
		return (
			<section className="dock crit" aria-label="confirm">
				<span className="lbl c-crit">
					confirm · {label} · /{ask.command}
				</span>
				<div className="ask">
					{ask.command === 'clear' ? 'Clear' : 'Compact'} {label}'s context?
				</div>
				<div className="cmd">{ask.text}</div>
				<div className="btns">
					<button
						type="button"
						className="btn primary"
						onClick={() => dispatch({ type: 'answer_command', askId: ask.id, isApproved: true })}
					>
						Yes{describeSaid(ask, 'yes')}
					</button>
					<button
						type="button"
						className="btn danger"
						onClick={() => dispatch({ type: 'answer_command', askId: ask.id, isApproved: false })}
					>
						No{describeSaid(ask, 'no')}
					</button>
				</div>
			</section>
		);
	}

	if (ask.kind === 'redirect') {
		return (
			<section className="dock crit" aria-label="switch">
				<span className="lbl c-crit">switch · {label}</span>
				<div className="ask">Stop what {label} is doing and switch to this?</div>
				<div className="cmd">{ask.text}</div>
				<div className="btns">
					<button
						type="button"
						className="btn primary"
						onClick={() => dispatch({ type: 'answer_redirect', askId: ask.id, isApproved: true })}
					>
						Switch{describeSaid(ask, 'yes')}
					</button>
					<button
						type="button"
						className="btn"
						onClick={() => dispatch({ type: 'answer_redirect', askId: ask.id, isApproved: false })}
					>
						After{describeSaid(ask, 'no')}
					</button>
				</div>
			</section>
		);
	}

	return <QuestionDock ask={ask} label={label} dispatch={dispatch} />;
};

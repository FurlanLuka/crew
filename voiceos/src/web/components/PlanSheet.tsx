import { useState } from 'react';
import type { PendingAsk } from '../../shared/protocol.js';
import type { Dispatch } from '../types.js';
import { SAY } from '../prompts.js';
import { Markdown } from './Markdown.js';
import { OwnAnswer, Sheet, SheetFoot, useOwnAnswer } from './PromptSheet.js';

type PlanAsk = Extract<PendingAsk, { kind: 'plan' }>;

interface PlanSheetProps {
	ask: PlanAsk;
	dispatch: Dispatch;
}

// A plan is read before it is approved (debug note 45): its box scrolls, "Read it all" makes it as
// tall as the sheet allows, and Approve stays in view either way.
export const PlanSheet = ({ ask, dispatch }: PlanSheetProps) => {
	const [isExpanded, setIsExpanded] = useState(false);
	const change = useOwnAnswer();

	const answer = (isApproved: boolean, message?: string) =>
		dispatch({ type: 'answer_plan', askId: ask.id, isApproved, ...(message ? { message } : {}) });

	return (
		<Sheet
			kind="plan"
			label="plan"
			tone="amber"
			title="Plan ready"
			reason="Read it before it starts"
		>
			<div className={`sh-body sh-plan ${isExpanded ? 'open' : ''}`}>
				<Markdown text={ask.plan} />
			</div>
			{change.isOpen ? (
				<OwnAnswer
					placeholder="What should change? It plans again with your words"
					submitLabel="Send"
					onSubmit={(message) => answer(false, message)}
					onCancel={change.cancel}
				/>
			) : (
				<SheetFoot sessionRef={ask.ref} say={SAY.plan}>
					<button type="button" className="btn ghost" onClick={() => setIsExpanded(!isExpanded)}>
						{isExpanded ? 'Show less' : 'Read it all'}
					</button>
					<button type="button" className="btn" ref={change.openerRef} onClick={change.open}>
						Change the plan…
					</button>
					<button type="button" className="btn primary" onClick={() => answer(true)}>
						Approve
					</button>
				</SheetFoot>
			)}
		</Sheet>
	);
};

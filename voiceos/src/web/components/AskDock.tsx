// What the session on screen waits on, docked above the voice bar (and in Set up's chat): one sheet
// per kind. Each is keyed by the ask, so a field left open on one ask never carries over to the next.
import type { PendingAsk } from '../../shared/protocol.js';
import type { Dispatch } from '../types.js';
import { describeConfirm, SAY } from '../prompts.js';
import { PeerSheet } from './PeerSheet.js';
import { PermissionSheet } from './PermissionSheet.js';
import { PlanSheet } from './PlanSheet.js';
import { Sheet, SheetFoot } from './PromptSheet.js';
import { QuestionSheet } from './QuestionSheet.js';

interface AskDockProps {
	ask: PendingAsk;
	label: string;
	dispatch: Dispatch;
}

type CommandAsk = Extract<PendingAsk, { kind: 'command' }>;
type RedirectAsk = Extract<PendingAsk, { kind: 'redirect' }>;

interface ConfirmSheetProps {
	ask: CommandAsk;
	dispatch: Dispatch;
}

const ConfirmSheet = ({ ask, dispatch }: ConfirmSheetProps) => {
	const copy = describeConfirm(ask);
	const answer = (isApproved: boolean) =>
		dispatch({ type: 'answer_command', askId: ask.id, isApproved });

	return (
		<Sheet
			kind="confirm"
			label="confirm"
			tone="plain"
			title={copy.title}
			reason={copy.reason}
			isRow={!copy.extra}
		>
			{copy.extra ? <p className="sh-quote">{copy.extra}</p> : null}
			<SheetFoot sessionRef={ask.ref} say={SAY.confirm}>
				<button type="button" className="btn ghost" onClick={() => answer(false)}>
					Keep it
				</button>
				<button type="button" className="btn primary" onClick={() => answer(true)}>
					{copy.verb}
				</button>
			</SheetFoot>
		</Sheet>
	);
};

interface RedirectSheetProps {
	ask: RedirectAsk;
	label: string;
	dispatch: Dispatch;
}

const RedirectSheet = ({ ask, label, dispatch }: RedirectSheetProps) => {
	const answer = (isApproved: boolean) =>
		dispatch({ type: 'answer_redirect', askId: ask.id, isApproved });

	return (
		<Sheet
			kind="switch"
			label="switch"
			tone="plain"
			title="Stop and switch to this?"
			reason={`${label} stops what it is doing`}
		>
			<p className="sh-quote">{ask.text}</p>
			<SheetFoot sessionRef={ask.ref} say={SAY.redirect}>
				<button type="button" className="btn" onClick={() => answer(false)}>
					After this
				</button>
				<button type="button" className="btn primary" onClick={() => answer(true)}>
					Switch now
				</button>
			</SheetFoot>
		</Sheet>
	);
};

export const AskDock = ({ ask, label, dispatch }: AskDockProps) => {
	switch (ask.kind) {
		case 'permission':
			return <PermissionSheet key={ask.id} ask={ask} dispatch={dispatch} />;
		case 'plan':
			return <PlanSheet key={ask.id} ask={ask} dispatch={dispatch} />;
		case 'command':
			return <ConfirmSheet key={ask.id} ask={ask} dispatch={dispatch} />;
		case 'redirect':
			return <RedirectSheet key={ask.id} ask={ask} label={label} dispatch={dispatch} />;
		case 'work':
		case 'secret':
			return <PeerSheet key={ask.id} ask={ask} dispatch={dispatch} />;
		case 'question':
			return <QuestionSheet key={ask.id} ask={ask} dispatch={dispatch} />;
	}
};

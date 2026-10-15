// Another session's request waiting on the developer: work its copy could not do without running
// something, or a secret it wants copied into a private file.
import type { PendingAsk } from '../../shared/protocol.js';
import type { Dispatch } from '../types.js';
import { SAY } from '../prompts.js';
import { LockIcon } from './icons.js';
import { SessionBadge } from './PeerCard.js';
import { Sheet, SheetFoot } from './PromptSheet.js';

type PeerAsk = Extract<PendingAsk, { kind: 'work' | 'secret' }>;

interface PeerSheetProps {
	ask: PeerAsk;
	dispatch: Dispatch;
}

export const PeerSheet = ({ ask, dispatch }: PeerSheetProps) => {
	const answer = (isApproved: boolean) =>
		dispatch({ type: 'answer_peer', askId: ask.id, isApproved });
	const isWork = ask.kind === 'work';

	return (
		<Sheet
			kind="peer"
			label="request from another session"
			tone="amber"
			title={
				isWork ? (
					<>
						<SessionBadge label={ask.fromLabel} /> wants <SessionBadge label={ask.toLabel} /> to do
						this and report back
					</>
				) : (
					<>
						<LockIcon /> <SessionBadge label={ask.fromLabel} /> wants a copy of{' '}
						<SessionBadge label={ask.toLabel} />
						’s <code>{ask.what}</code>
					</>
				)
			}
			reason={
				isWork
					? null
					: `It goes into a private file only ${ask.fromLabel} can read. Neither session sees the value.`
			}
		>
			{isWork ? (
				<div className="sh-body">
					<p className="sh-task">{ask.text}</p>
				</div>
			) : null}
			<SheetFoot sessionRef={ask.ref} say={SAY.peer}>
				<button type="button" className="btn deny" onClick={() => answer(false)}>
					No
				</button>
				<button type="button" className="btn primary" onClick={() => answer(true)}>
					Allow
				</button>
			</SheetFoot>
		</Sheet>
	);
};

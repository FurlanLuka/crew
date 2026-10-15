// One exchange with another session, on the session that asked: the answer is in this conversation,
// so the whole exchange lives here — who, what kind, where it stands, the question, and what came
// back. The asked session shows it only in its side panel (PeerRunsPanel).
import type { PeerRun, StreamItem } from '../../shared/protocol.js';
import { formatAge } from '../../state/working.js';
import { describePeerCard, readInitials, readSessionColor } from '../derive.js';
import { useNow } from '../use-now.js';
import { AttachedFiles } from './AttachmentChips.js';
import { LockIcon } from './icons.js';
import { Markdown } from './Markdown.js';

type AskCard = Extract<StreamItem, { kind: 'session_ask' }>;

const ELAPSED_TICK_MS = 1000;

interface SessionBadgeProps {
	label: string;
}

// Coloured by its label: the one thing every place that names a session has (a From card has no ref).
export const SessionBadge = ({ label }: SessionBadgeProps) => (
	<span className="pc-who">
		<span className="pc-ava" data-color={readSessionColor(label)} aria-hidden="true">
			{readInitials(label)}
		</span>
		{label}
	</span>
);

const WaitingLine = ({ item, run, onOpen }: PeerCardProps) => {
	const now = useNow(ELAPSED_TICK_MS);
	const doing = item.request === 'secret' ? 'Copying it' : `A copy of ${item.peer} is looking`;

	return (
		<div className="pc-foot pc-wait">
			<span className="pc-spin" aria-hidden="true" />
			<span className="pc-step">
				{doing}
				{run?.step && <> · {run.step}</>}
			</span>
			<span className="pc-el">{formatAge(now - item.at)}</span>
			{onOpen && (
				<button type="button" className="pc-link" onClick={onOpen}>
					View steps
				</button>
			)}
		</div>
	);
};

const Answer = ({ item, onOpen }: PeerCardProps) => {
	if (item.request === 'secret') {
		return item.status === 'answered' ? (
			<div className="pc-foot pc-col">
				<span className="pc-files">
					In a private file <code>{item.answer}</code>
				</span>
				<span className="pc-note">Neither session saw the value.</span>
			</div>
		) : item.answer && item.status !== 'waiting_ok' ? (
			<div className="pc-foot pc-note">{item.answer}</div>
		) : null;
	}

	if (item.request === 'tell') {
		return item.files?.length || item.status === 'failed' || item.status === 'refused' ? (
			<div className="pc-foot pc-col">
				{item.files?.length ? <AttachedFiles attachments={item.files} /> : null}
				{(item.status === 'failed' || item.status === 'refused') && item.answer && (
					<span className="pc-note">{item.answer}</span>
				)}
			</div>
		) : null;
	}

	if (item.status === 'answered') {
		return (
			<div className="pc-foot pc-col">
				<div className="pc-answer">
					<Markdown text={item.answer ?? ''} />
				</div>
				{item.files?.length ? <AttachedFiles attachments={item.files} /> : null}
				{(item.read?.length || onOpen) && (
					<div className="pc-row">
						{item.read?.length ? (
							<span className="pc-files">
								Read{' '}
								{item.read.map((path) => (
									<code key={path}>{path}</code>
								))}
							</span>
						) : null}
						{onOpen && (
							<button type="button" className="pc-link" onClick={onOpen}>
								View steps
							</button>
						)}
					</div>
				)}
			</div>
		);
	}

	return item.answer ? <div className="pc-foot pc-note">{item.answer}</div> : null;
};

interface PeerCardProps {
	item: AskCard;
	// The asked session's row for it: its live step. Absent on a page that has none to show.
	run?: PeerRun;
	// Opens the copy's steps.
	onOpen?: () => void;
}

export const PeerCard = (props: PeerCardProps) => {
	const { item } = props;
	const look = describePeerCard(item);

	return (
		<div className="pc" data-request={item.request} data-status={item.status}>
			<div className="pc-head">
				{item.request === 'secret' && <LockIcon />}
				<span>{look.verb}</span>
				<SessionBadge label={item.peer} />
				{look.after && <span>{look.after}</span>}
				<span className={`pc-pill ${look.pill.tone}`}>{look.pill.label}</span>
			</div>
			<div className="pc-q">{item.request === 'secret' ? <code>{item.text}</code> : item.text}</div>
			{look.isWaiting ? <WaitingLine {...props} /> : <Answer {...props} />}
		</div>
	);
};

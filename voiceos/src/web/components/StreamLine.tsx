import { readApprovalSummary } from '../../shared/approval.js';
import type { PeerRun, StreamItem } from '../../shared/protocol.js';
import { classifyDiffLine } from '../derive.js';
import { Markdown } from './Markdown.js';
import { DocCard } from './DocCard.js';
import { buildMediaUrl } from '../media.js';
import { AttachedFiles } from './AttachmentChips.js';
import { PeerCard, SessionBadge } from './PeerCard.js';
import { WorkingClock, WorkingDots } from './WorkingLine.js';

const ASIDE_STATUS_TEXT = {
	asking: 'asking aside…',
	answered: 'answered',
	queued: 'queued: needs its tools',
	failed: 'could not answer aside: queued',
	withdrawn: 'replaced by what you said next',
} as const;

// The bubble already says BTW: the words that made it one are not repeated.
const stripBtw = (question: string): string =>
	question.replace(/^\s*(?:btw|by the way)\b[\s,:;.-]*/i, '') || question;

interface StreamLineProps {
	item: StreamItem;
	// Given for an Agent call whose sub-agent's transcript is kept: the row opens it. On an exchange
	// with another session, it opens the copy's steps.
	onOpen?: () => void;
	// The asked session's row for an exchange with another session: its live step.
	peerRun?: PeerRun;
	// The tool call still running, since when: its line shows it at work.
	runningSince?: number;
}

export const StreamLine = ({ item, onOpen, peerRun, runningSince }: StreamLineProps) => {
	switch (item.kind) {
		case 'user':
			// Another session's words (or Voice OS's, for a secret): labelled as theirs, never shown as
			// the developer's.
			if (item.from) {
				return (
					<div className="pc pc-from">
						<div className="pc-head">
							<span>From</span>
							<SessionBadge label={item.from} />
						</div>
						<div className="pc-q">
							<Markdown text={item.text} />
						</div>
						{item.attachments?.length ? (
							<div className="pc-foot">
								<AttachedFiles attachments={item.attachments} />
							</div>
						) : null}
					</div>
				);
			}

			return item.isApproval ? (
				<div className="line approval">✓ Allowed once: {readApprovalSummary(item.text)}</div>
			) : item.attachments?.length ? (
				<div className="line user">
					› {item.text}
					<AttachedFiles attachments={item.attachments} />
				</div>
			) : (
				<div className="line user">› {item.text}</div>
			);
		case 'text':
			return (
				<div className="line text">
					<Markdown text={item.text} />
				</div>
			);
		case 'tool': {
			const isRunning = runningSince !== undefined;
			const body = (
				<>
					{isRunning ? <WorkingDots /> : <span className="c-amber">▸</span>} {item.summary}
					{isRunning && (
						<>
							{' '}
							<WorkingClock since={runningSince} />
						</>
					)}
				</>
			);

			return onOpen ? (
				<button
					type="button"
					className={isRunning ? 'line tool opens running' : 'line tool opens'}
					onClick={onOpen}
				>
					{body} <span className="opens-hint">· open</span>
				</button>
			) : (
				<div className={isRunning ? 'line tool running' : 'line tool'}>{body}</div>
			);
		}
		case 'tool_result':
			return item.ok ? null : <div className="line result c-crit"> ✕ {item.summary}</div>;
		case 'diff':
			return (
				<div className="diff">
					{item.lines.map((line, index) => (
						<div key={index} className={classifyDiffLine(line)}>
							{line || ' '}
						</div>
					))}
				</div>
			);
		case 'notice':
			return <div className="line notice">{item.text}</div>;
		case 'image': {
			const src = buildMediaUrl(item.name);

			return (
				<a className="line shown-image" href={src} target="_blank" rel="noopener noreferrer">
					<img src={src} alt={item.alt || 'image from the session'} loading="lazy" />
				</a>
			);
		}
		case 'doc':
			return <DocCard url={item.url} title={item.title} />;
		case 'session_ask':
			return (
				<PeerCard
					item={item}
					{...(peerRun ? { run: peerRun } : {})}
					{...(onOpen ? { onOpen } : {})}
				/>
			);
		case 'aside':
			// A side question to this session: its own bubble, never a rail that reads like another session.
			return (
				<div className="btw" data-status={item.status}>
					<div className="btw-q">
						<b>BTW</b>
						{stripBtw(item.question)}
						{item.status !== 'answered' && (
							<span className="c-dim"> · {ASIDE_STATUS_TEXT[item.status]}</span>
						)}
					</div>
					{item.answer && (
						<div className="btw-a">
							<Markdown text={item.answer} />
						</div>
					)}
				</div>
			);
	}
};

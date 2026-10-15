// A session's stream as every page draws it: its lines, the reply still arriving with its caret, the
// compaction bar and the working line, kept at the end as it grows. Voice OS's session and Set up's
// chat both draw it; what each adds (a line under an item, a note at the end) comes in through the
// slots.
import type { ReactNode } from 'react';
import type { PeerRun, Session, StreamItem } from '../../shared/protocol.js';
import { stripStreamingTag } from '../../shared/spoken-tags.js';
import { useStickToBottom } from '../use-stick-to-bottom.js';
import { CompactingLine } from './CompactingLine.js';
import { Markdown } from './Markdown.js';
import { StreamLine } from './StreamLine.js';
import { ThinkingLine, WaitingLine } from './WorkingLine.js';
import { readWorkingState } from '../working-line.js';

interface SessionStreamProps {
	// Scrolls to the end when it changes: the session on screen.
	sessionRef: string;
	// Absent before the session exists: only the children show.
	session: Session | undefined;
	className: string;
	// Drawn right under an item: Set up's "✓ recorded" line.
	renderAfter?: (item: StreamItem) => ReactNode;
	// What clicking an item opens, if anything: an Agent call's row opens its sub-agent's transcript,
	// an exchange with another session its copy's steps.
	openFor?: (item: StreamItem) => (() => void) | null;
	// The asked session's row for an exchange with another session: its live step.
	peerRunFor?: (item: StreamItem) => PeerRun | null;
	// A question or a permission is open for it: its foot says it waits on you.
	hasAsk?: boolean;
	// Drawn after the stream: a note about the session's state.
	children?: ReactNode;
}

export const SessionStream = ({
	sessionRef,
	session,
	className,
	renderAfter,
	openFor,
	peerRunFor,
	hasAsk = false,
	children,
}: SessionStreamProps) => {
	// The compaction bar is added at the end of the stream too: it comes into view like a line.
	const streamRef = useStickToBottom<HTMLElement>(sessionRef);
	const draft = session ? stripStreamingTag(session.draft) : '';
	const working = session ? readWorkingState(session, hasAsk) : null;
	const runningToolId = working?.kind === 'tool' ? working.itemId : null;

	return (
		<section className={className} aria-label="stream" ref={streamRef}>
			{session?.stream.map((item) => {
				const after = renderAfter?.(item);
				const onOpen = openFor?.(item);
				const peerRun = peerRunFor?.(item);
				const opens = { ...(onOpen ? { onOpen } : {}), ...(peerRun ? { peerRun } : {}) };
				const running =
					item.id === runningToolId && working?.kind === 'tool'
						? { runningSince: working.since }
						: {};

				return after ? (
					<div key={item.id} className="stream-item">
						<StreamLine item={item} {...opens} {...running} />
						{after}
					</div>
				) : (
					<StreamLine key={item.id} item={item} {...opens} {...running} />
				);
			})}
			{draft && (
				<div className="line text">
					<Markdown text={draft} />
					<span className="caret" />
				</div>
			)}
			{session && session.compactingSince !== null && (
				<CompactingLine since={session.compactingSince} />
			)}
			{working?.kind === 'thinking' && <ThinkingLine since={working.since} />}
			{working?.kind === 'waiting' && <WaitingLine />}
			{children}
		</section>
	);
};

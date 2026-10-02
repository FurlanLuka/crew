// A session's stream as every page draws it: its lines, the reply still arriving with its caret, and
// the compaction bar, kept at the end as it grows. Voice OS's session and Set up's chat both draw it;
// what each adds (a line under an item, a note at the end) comes in through the slots.
import type { ReactNode } from 'react';
import type { Session, StreamItem } from '../../shared/protocol.js';
import { stripStreamingTag } from '../../shared/spoken-tags.js';
import { useStickToBottom } from '../use-stick-to-bottom.js';
import { CompactingLine } from './CompactingLine.js';
import { Markdown } from './Markdown.js';
import { StreamLine } from './StreamLine.js';

interface SessionStreamProps {
	// Scrolls to the end when it changes: the session on screen.
	sessionRef: string;
	// Absent before the session exists: only the children show.
	session: Session | undefined;
	className: string;
	// Drawn right under an item: Set up's "✓ recorded" line.
	renderAfter?: (item: StreamItem) => ReactNode;
	// Drawn after the stream: a note about the session's state.
	children?: ReactNode;
}

export const SessionStream = ({
	sessionRef,
	session,
	className,
	renderAfter,
	children,
}: SessionStreamProps) => {
	// The compaction bar is added at the end of the stream too: it comes into view like a line.
	const streamRef = useStickToBottom<HTMLElement>(sessionRef);
	const draft = session ? stripStreamingTag(session.draft) : '';

	return (
		<section className={className} aria-label="stream" ref={streamRef}>
			{session?.stream.map((item) => {
				const after = renderAfter?.(item);

				return after ? (
					<div key={item.id} className="stream-item">
						<StreamLine item={item} />
						{after}
					</div>
				) : (
					<StreamLine key={item.id} item={item} />
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
			{children}
		</section>
	);
};

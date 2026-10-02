import { readApprovalSummary } from '../../shared/approval.js';
import type { StreamItem } from '../../shared/protocol.js';
import { classifyDiffLine } from '../derive.js';
import { Markdown } from './Markdown.js';
import { DocCard } from './DocCard.js';
import { buildMediaUrl } from '../media.js';

const ASIDE_STATUS_TEXT = {
	asking: 'asking aside…',
	answered: 'aside',
	queued: 'queued: needs its tools',
	failed: 'could not answer aside: queued',
	withdrawn: 'replaced by what you said next',
} as const;

interface StreamLineProps {
	item: StreamItem;
}

export const StreamLine = ({ item }: StreamLineProps) => {
	switch (item.kind) {
		case 'user':
			return item.isApproval ? (
				<div className="line approval">✓ Allowed once: {readApprovalSummary(item.text)}</div>
			) : (
				<div className="line user">› {item.text}</div>
			);
		case 'text':
			return (
				<div className="line text">
					<Markdown text={item.text} />
				</div>
			);
		case 'tool':
			return (
				<div className="line tool">
					<span className="c-amber">▸</span> {item.summary}
				</div>
			);
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
		case 'aside':
			return (
				<div className="aside" data-status={item.status}>
					<div className="line user">
						› {item.question} <span className="c-dim">· {ASIDE_STATUS_TEXT[item.status]}</span>
					</div>
					{item.answer && (
						<div className="line text">
							<Markdown text={item.answer} />
						</div>
					)}
				</div>
			);
	}
};

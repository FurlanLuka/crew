import type { StreamItem } from '../../shared/protocol.js';
import { classifyDiffLine } from '../derive.js';

interface StreamLineProps {
	item: StreamItem;
}

export const StreamLine = ({ item }: StreamLineProps) => {
	switch (item.kind) {
		case 'user':
			return <div className="line user">› {item.text}</div>;
		case 'text':
			return <div className="line text">{item.text}</div>;
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
	}
};

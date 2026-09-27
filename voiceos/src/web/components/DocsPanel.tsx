import type { Session } from '../../shared/protocol.js';
import { listDocs } from '../derive.js';

interface DocsPanelProps {
	session: Session;
}

// The docs and artifacts this session made, newest first — "open the doc" opens the top one.
export const DocsPanel = ({ session }: DocsPanelProps) => {
	const docs = listDocs(session);

	if (docs.length === 0) {
		return null;
	}

	return (
		<section className="panel docs" aria-label="docs">
			<span className="lbl">docs · {docs.length}</span>
			{docs.map((doc) => (
				<a
					key={doc.url}
					className="row doc-row"
					href={doc.url}
					target="_blank"
					rel="noopener noreferrer"
				>
					{doc.title} ↗
				</a>
			))}
		</section>
	);
};

interface DocCardProps {
	url: string;
	title: string;
}

const readHost = (url: string): string => {
	try {
		return new URL(url).hostname.replace(/^www\./, '');
	} catch {
		return url;
	}
};

// A doc or artifact the session made: opened in a new tab, the cockpit stays where it is.
export const DocCard = ({ url, title }: DocCardProps) => (
	<a className="line doc-card" href={url} target="_blank" rel="noopener noreferrer">
		<span className="doc-title">{title}</span>
		<span className="doc-host c-dim">{readHost(url)} ↗</span>
	</a>
);

import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const REMARK_PLUGINS = [remarkGfm];

// Links leave the cockpit: it holds live sessions that a navigation would drop.
const COMPONENTS: Components = {
	a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
	// An image in the text would point at a path on the server the browser cannot reach; the
	// session's shown images come as their own lines, served through /media.
	img: () => null,
};

interface MarkdownProps {
	text: string;
}

// Memoized: the streamed draft re-renders on every delta, the finished lines above it need not.
export const Markdown = memo(({ text }: MarkdownProps) => (
	<div className="md">
		<ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
			{text}
		</ReactMarkdown>
	</div>
));

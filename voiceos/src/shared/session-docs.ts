import type { StreamItem } from './protocol.js';

export interface SessionDoc {
	url: string;
	title: string;
}

// A session's docs, newest first, each once: the Docs panel, "open the doc" and what the kernel
// is told all read the same list.
export const listSessionDocs = (stream: StreamItem[]): SessionDoc[] => {
	const seen = new Set<string>();
	const docs: SessionDoc[] = [];

	for (const item of [...stream].reverse()) {
		if (item.kind === 'doc' && !seen.has(item.url)) {
			seen.add(item.url);
			docs.push({ url: item.url, title: item.title });
		}
	}

	return docs;
};

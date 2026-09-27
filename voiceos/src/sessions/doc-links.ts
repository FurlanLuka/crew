// Documents and artifacts a session made or linked: each becomes a card in its page, and
// "open the doc" opens the newest.

export interface DocLink {
	url: string;
	title: string;
}

const MARKDOWN_LINK_PATTERN = /\[([^\]\n]{1,300})\]\((https:\/\/[^)\s]{1,2000})\)/g;
const URL_PATTERN = /https:\/\/[^\s)<>"'`\]]{1,2000}/g;

// What counts as a doc: a claude.ai artifact, a Google document, sheet, slide deck or Drive
// file, a Notion page. Other claude.ai pages (/new, /settings) and other sites are just links.
const isDocUrl = (url: string): boolean => {
	let parsed: URL;

	try {
		parsed = new URL(url);
	} catch {
		return false;
	}

	const host = parsed.hostname.toLowerCase();
	const path = parsed.pathname;

	switch (true) {
		case parsed.protocol !== 'https:':
			return false;
		case host === 'claude.ai':
			return /\/artifact\/[\w-]+/.test(path);
		case host === 'docs.google.com':
			return /^\/(?:document|spreadsheets|presentation)\/d\//.test(path);
		case host === 'drive.google.com':
			return /^\/file\/d\//.test(path);
		case host === 'notion.so' || host === 'www.notion.so' || host.endsWith('.notion.site'):
			return path.length > 1;
		default:
			return false;
	}
};

// A name for a link with no text of its own.
export const describeDocUrl = (url: string): string => {
	const host = new URL(url).hostname.replace(/^www\./, '');

	if (host === 'claude.ai') {
		return 'Claude artifact';
	}

	if (host.endsWith('google.com')) {
		return 'Google doc';
	}

	return 'Notion page';
};

const trimUrl = (url: string): string => url.replace(/[.,;:!?]+$/, '');

export const findDocLinks = (text: string): DocLink[] => {
	const found = new Map<string, DocLink>();

	for (const match of text.matchAll(MARKDOWN_LINK_PATTERN)) {
		const url = trimUrl(match[2] ?? '');

		if (isDocUrl(url)) {
			found.set(url, { url, title: (match[1] ?? '').trim() || describeDocUrl(url) });
		}
	}

	for (const match of text.matchAll(URL_PATTERN)) {
		const url = trimUrl(match[0]);

		if (isDocUrl(url) && !found.has(url)) {
			found.set(url, { url, title: describeDocUrl(url) });
		}
	}

	return [...found.values()];
};

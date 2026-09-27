import { describe, expect, it } from 'bun:test';
import { describeDocUrl, findDocLinks } from './doc-links.js';

describe('findDocLinks', () => {
	it.each([
		[
			'a claude.ai artifact with its link text',
			'Wrote the plan: [Checkout retry plan](https://claude.ai/code/artifact/c4902df8-a792).',
			[{ url: 'https://claude.ai/code/artifact/c4902df8-a792', title: 'Checkout retry plan' }],
		],
		[
			'a bare claude.ai artifact, named by what it is',
			'Made it: https://claude.ai/artifact/abc123',
			[{ url: 'https://claude.ai/artifact/abc123', title: 'Claude artifact' }],
		],
		[
			'a Google Doc, trailing period trimmed',
			'It is at https://docs.google.com/document/d/xyz/edit.',
			[{ url: 'https://docs.google.com/document/d/xyz/edit', title: 'Google doc' }],
		],
		[
			'a Drive file',
			'https://drive.google.com/file/d/abc/view',
			[{ url: 'https://drive.google.com/file/d/abc/view', title: 'Google doc' }],
		],
		[
			'a Notion page',
			'https://www.notion.so/team/Retry-notes-123',
			[{ url: 'https://www.notion.so/team/Retry-notes-123', title: 'Notion page' }],
		],
		[
			'other claude.ai pages are links, not docs',
			'Go to https://claude.ai/new or https://claude.ai/settings',
			[],
		],
		['a Google page that is not a document', 'https://docs.google.com/forms/d/x', []],
		[
			'an ordinary site, or plain http',
			'Docs at https://example.com/docs and http://claude.ai/artifact/x',
			[],
		],
		['a host that only looks like claude.ai', 'https://claude.ai.evil.com/artifact/x', []],
		['a host that ends like it', 'https://notclaude.ai/artifact/x', []],
		['a doc host in the path of another site', 'https://evil.com/notion.so/page', []],
	])('%s', (_label, text, expected) => {
		expect(findDocLinks(text)).toEqual(expected);
	});

	it('names a link with no text of its own by what it is', () => {
		expect(describeDocUrl('https://claude.ai/code/artifact/abc')).toBe('Claude artifact');
		expect(describeDocUrl('https://docs.google.com/document/d/x')).toBe('Google doc');
		expect(describeDocUrl('https://acme.notion.site/Plan')).toBe('Notion page');
	});
});

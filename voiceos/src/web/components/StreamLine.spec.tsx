import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { StreamLine } from './StreamLine.js';

describe('StreamLine: what a session shows', () => {
	it('an image loads through /media by its stored name', () => {
		const name = `${'a'.repeat(32)}.png`;
		const html = renderToStaticMarkup(
			<StreamLine item={{ id: 'i1', at: 1, kind: 'image', name, alt: 'login' }} />,
		);

		expect(html).toContain(`src="/media?name=${name}"`);
		expect(html).toContain('alt="login"');
	});

	it('a doc is a card that opens in a new tab', () => {
		const html = renderToStaticMarkup(
			<StreamLine
				item={{
					id: 'd1',
					at: 1,
					kind: 'doc',
					url: 'https://claude.ai/artifact/a1',
					title: 'Retry plan',
				}}
			/>,
		);

		expect(html).toContain('href="https://claude.ai/artifact/a1"');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('Retry plan');
		expect(html).toContain('claude.ai');
	});
});

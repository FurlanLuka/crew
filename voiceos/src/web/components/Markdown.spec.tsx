import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from './Markdown.js';

const render = (text: string): string => renderToStaticMarkup(<Markdown text={text} />);

describe('Markdown', () => {
	it('renders GFM: headings, emphasis, lists, task lists, code, tables', () => {
		const html = render(
			[
				'## Result',
				'**Bold** and _em_ with `code`.',
				'- [x] done',
				'- [ ] todo',
				'```',
				'npm test',
				'```',
				'| a | b |',
				'| --- | --- |',
				'| 1 | 2 |',
			].join('\n'),
		);

		expect(html).toContain('<h2>Result</h2>');
		expect(html).toContain('<strong>Bold</strong>');
		expect(html).toContain('<em>em</em>');
		expect(html).toContain('<code>code</code>');
		expect(html).toContain('type="checkbox"');
		expect(html).toContain('<pre><code>npm test');
		expect(html).toContain('<table>');
		expect(html).toContain('<td>2</td>');
	});

	it('links open in a new tab, without a way back to the cockpit', () =>
		expect(render('[docs](https://example.com)')).toContain(
			'<a href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a>',
		));

	it('raw HTML is dropped, never rendered as elements', () => {
		const html = render('<img src=x onerror="alert(1)"> <script>alert(2)</script> after');

		expect(html).not.toContain('<img');
		expect(html).not.toContain('<script');
		expect(html).toContain('after');
	});

	it('a javascript: link loses its target', () =>
		expect(render('[x](javascript:alert(1))')).not.toContain('javascript:'));

	it('a half-streamed reply with an open fence → renders without throwing', () =>
		expect(render('Here:\n```ts\nconst a')).toContain('const a'));
});

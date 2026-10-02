import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CommandLine, formatCommand, shellQuote } from './CommandLine.js';

describe('CommandLine', () => {
	it('quotes what a shell would split, and nothing else', () => {
		expect(shellQuote('store-front/main')).toBe('store-front/main');
		expect(shellQuote('pnpm dev')).toBe("'pnpm dev'");
		expect(shellQuote("it's")).toBe(`'it'\\''s'`);
	});

	it('the line a developer would type: no --json', () =>
		expect(formatCommand({ type: 'add_worktree', ref: 'store-front/search', pull: true })).toBe(
			'crew add worktree store-front/search --pull',
		));

	it('a key or a bundle goes on stdin and is never printed', () => {
		const line = formatCommand({ type: 'keys_set', name: 'anthropic', value: 'sk-ant-secret' });

		expect(line).toBe('crew server keys set anthropic < the key');
		expect(line).not.toContain('secret');
	});

	it('every command on its own line, then what happens after', () => {
		const html = renderToStaticMarkup(
			<CommandLine
				commands={[
					{ type: 'add_project', name: 'payments', url: 'https://github.com/acme/payments.git' },
					null,
					{ type: 'add_workspace', name: 'payments', projects: ['payments'] },
				]}
				then="set up its install"
			/>,
		);

		expect(html).toContain('Runs');
		expect(html).toContain(
			'crew add project payments https://github.com/acme/payments.git\ncrew add workspace payments payments\nthen: set up its install',
		);
	});

	it('nothing to run → nothing shown', () =>
		expect(renderToStaticMarkup(<CommandLine commands={[null]} />)).toBe(''));
});

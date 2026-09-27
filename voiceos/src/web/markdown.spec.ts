import { describe, expect, it } from 'bun:test';
import { stripMarkdown } from './markdown.js';

describe('stripMarkdown', () => {
	it.each([
		['**Tests pass.** _All_ green', 'Tests pass. All green'],
		['## Summary\nDone.', 'Summary\nDone.'],
		['- one\n- two', 'one\ntwo'],
		['1. first\n2. second', 'first\nsecond'],
		['- [x] done\n- [ ] todo', 'done\ntodo'],
		['Run `npm test` now', 'Run npm test now'],
		['See [the docs](https://x.dev/a_b) here', 'See the docs here'],
		['> quoted', 'quoted'],
		['```ts\nconst a = 1;\n```', 'const a = 1;'],
		['| a | b |\n| --- | --- |\n| 1 | 2 |', 'a  b\n1  2'],
		['~~old~~ new', 'old new'],
	])('%p → %p', (text, plain) => expect(stripMarkdown(text)).toBe(plain));

	it.each([
		'rename snake_case_name',
		'src/__tests__/a.ts',
		'2 * 3 * 4',
		'fixes #123 today',
		'-1 is the default',
		'a_b and c_d',
		'cat a.log | grep err',
		'a || b',
	])('%p stays as written', (text) => expect(stripMarkdown(text)).toBe(text));
});

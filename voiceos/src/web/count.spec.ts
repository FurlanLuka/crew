import { describe, expect, it } from 'bun:test';
import { countOf } from './count.js';

const HAND_ROLLED = /\{([\w.]+)\}\s*\$?\{\1 === 1 \?/;
// A count-named expression followed by a plural noun (an adjective may sit between): "1 things".
const FIXED_PLURAL =
	/\$\{[\w.]*(?:[cC]ount|length|entries|[tT]otal)\} (?:[a-z]+ )?(?!(?:was|has|does|goes)\b)[a-z]+[^su\s]s\b/;

describe('countOf', () => {
	it.each([
		[0, 'project', undefined, '0 projects'],
		[1, 'project', undefined, '1 project'],
		[2, 'workspace', undefined, '2 workspaces'],
		[1, 'variable', undefined, '1 variable'],
		[3, 'thing needs', 'things need', '3 things need'],
		[1, 'thing needs', 'things need', '1 thing needs'],
	])('%d %s', (count, singular, plural, want) => {
		expect(countOf(count, singular, plural)).toBe(want);
	});
});

describe('the one plural rule', () => {
	const scanPages = async (rule: RegExp): Promise<string[]> => {
		const glob = new Bun.Glob('**/*.{ts,tsx}');
		const found: string[] = [];

		for await (const path of glob.scan({ cwd: import.meta.dir })) {
			if (path.startsWith('count.') || path.endsWith('.spec.ts')) {
				continue;
			}

			const source = await Bun.file(`${import.meta.dir}/${path}`).text();

			if (rule.test(source)) {
				found.push(path);
			}
		}

		return found;
	};

	it('no page file counts by hand ("{n} {n === 1 ? …}"): it goes through countOf', async () => {
		expect(await scanPages(HAND_ROLLED)).toEqual([]);
	});

	it('no page file puts a count before a fixed plural ("${n} things"): it goes through countOf', async () => {
		expect(await scanPages(FIXED_PLURAL)).toEqual([]);
	});

	it.each([
		['`${leftCount} things crew can clear`', true],
		['`${trash.data.entries} removed checkouts · ${size}`', true],
		['`${failed.length} projects failed`', true],
		["`${countOf(n, 'project')} failed`", false],
		['`${ms} ms`', false],
		['`${label} is working`', false],
		['`${count} is ready`', false],
		['`${host.trim()} as a machine`', false],
		['`${total} was cleared`', false],
		['`${count} has finished`', false],
		['`${rows.length} does`', false],
		["`${counts} ${needs === 1 ? 'One thing needs' : `${needs} things need`} you.`", false],
	])('the fixed-plural rule on %s → %p', (line, isCaught) => {
		expect(FIXED_PLURAL.test(line)).toBe(isCaught);
	});
});

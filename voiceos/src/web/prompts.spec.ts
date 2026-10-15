import { describe, expect, it } from 'bun:test';
import {
	type CommandSegment,
	describeAlways,
	describeConfirm,
	describePermission,
	readOptionWord,
	splitCommand,
} from './prompts.js';

const rejoin = (segments: CommandSegment[]): string =>
	segments.map((segment) => segment.text).join('');

const programs = (command: string): string[] =>
	splitCommand(command)
		.filter((segment) => segment.role === 'program')
		.map((segment) => segment.text);

const operators = (command: string): string[] =>
	splitCommand(command)
		.filter((segment) => segment.role === 'operator')
		.map((segment) => segment.text);

describe('splitCommand', () => {
	const COMMANDS = [
		'git push',
		'pnpm i && pnpm test',
		'a || b',
		'a | b',
		'a; b',
		'echo "a && b"',
		"echo 'x | y'",
		'cmd 2>&1 | tee log',
		'FOO=1 pnpm test',
		'  bun test  ',
		'bun test \\\n  --watch',
		'cat <<EOF\na; b\nEOF',
		'echo $(git rev-parse HEAD) && git push',
		'echo "unclosed && quote',
		'echo \\"a && b',
		'make build\nmake test',
		'',
	];

	it('every command → its segments join back to it exactly', () => {
		for (const command of COMMANDS) {
			expect(rejoin(splitCommand(command))).toBe(command);
		}
	});

	it('pnpm i && pnpm test | tee log; echo "a && b" → programs, operators and arguments in order', () =>
		expect(splitCommand('pnpm i && pnpm test | tee log; echo "a && b"')).toEqual([
			{ text: 'pnpm', role: 'program' },
			{ text: ' i ', role: 'arg' },
			{ text: '&&', role: 'operator' },
			{ text: ' ', role: 'arg' },
			{ text: 'pnpm', role: 'program' },
			{ text: ' test ', role: 'arg' },
			{ text: '|', role: 'operator' },
			{ text: ' ', role: 'arg' },
			{ text: 'tee', role: 'program' },
			{ text: ' log', role: 'arg' },
			{ text: ';', role: 'operator' },
			{ text: ' ', role: 'arg' },
			{ text: 'echo', role: 'program' },
			{ text: ' "a && b"', role: 'arg' },
		]));

	it('git push → one program', () => expect(programs('git push')).toEqual(['git']));

	it('||, | and ; → each its own operator, || never two pipes', () => {
		expect(operators('a || b')).toEqual(['||']);
		expect(operators('a | b')).toEqual(['|']);
		expect(operators('a; b')).toEqual([';']);
	});

	it('operators inside quotes → part of the argument', () => {
		expect(operators('echo "a && b"')).toEqual([]);
		expect(operators("echo 'x | y'")).toEqual([]);
		expect(operators('echo "say \\" && still quoted"')).toEqual([]);
	});

	it('an escaped quote → not the start of a quote', () =>
		expect(operators('echo \\"a && b')).toEqual(['&&']));

	it('2>&1 → an argument; only the pipe is an operator', () =>
		expect(operators('cmd 2>&1 | tee log')).toEqual(['|']));

	it('FOO=1 pnpm test → pnpm is the program, the assignment an argument', () =>
		expect(programs('FOO=1 pnpm test')).toEqual(['pnpm']));

	it('two lines → the newline separates two commands', () => {
		expect(operators('make build\nmake test')).toEqual(['\n']);
		expect(programs('make build\nmake test')).toEqual(['make', 'make']);
	});

	it('a heredoc or a $( ) → only the first word lit, nothing inside split', () => {
		expect(programs('cat <<EOF\na; b\nEOF')).toEqual(['cat']);
		expect(operators('echo $(git rev-parse HEAD) && git push')).toEqual([]);
	});

	it('only spaces, or nothing → no program, no crash', () => {
		expect(programs('   ')).toEqual([]);
		expect(splitCommand('')).toEqual([]);
	});
});

describe('describePermission', () => {
	it('Bash with a description → asks to run it, the description as the reason, the command as the body', () =>
		expect(
			describePermission({
				toolName: 'Bash',
				input: { command: 'git push', description: 'Push the fix' },
				summary: 'run git push',
			}),
		).toEqual({
			title: 'Run this command?',
			reason: 'Push the fix',
			body: {
				kind: 'command',
				segments: [
					{ text: 'git', role: 'program' },
					{ text: ' push', role: 'arg' },
				],
			},
		}));

	it('Bash without a description → no reason', () =>
		expect(
			describePermission({ toolName: 'Bash', input: { command: 'ls' }, summary: 'run ls' }).reason,
		).toBeNull());

	it('Bash whose command is not text → no empty box: its summary carries nothing either', () =>
		expect(
			describePermission({ toolName: 'Bash', input: { command: 42 }, summary: 'run ' }).body,
		).toBeNull());

	it('an edit without its path → no empty box', () =>
		expect(describePermission({ toolName: 'Edit', input: {}, summary: 'edit ' }).body).toBeNull());

	it('Edit and MultiEdit → the path from the summary, made short on the session’s machine', () => {
		for (const toolName of ['Edit', 'MultiEdit']) {
			expect(
				describePermission({
					toolName,
					input: { file_path: '/w/store-front/main/src/api/orders.ts' },
					summary: 'edit src/api/orders.ts',
				}),
			).toEqual({
				title: 'Edit this file?',
				reason: null,
				body: { kind: 'text', text: 'src/api/orders.ts' },
			});
		}
	});

	it('NotebookEdit → its notebook path', () =>
		expect(
			describePermission({
				toolName: 'NotebookEdit',
				input: { notebook_path: '/w/a/report.ipynb' },
				summary: 'edit notebook report.ipynb',
			}),
		).toEqual({
			title: 'Edit this notebook?',
			reason: null,
			body: { kind: 'text', text: 'report.ipynb' },
		}));

	it('Write → asks to write the file', () =>
		expect(
			describePermission({ toolName: 'Write', input: {}, summary: 'write CHANGELOG.md' }),
		).toEqual({
			title: 'Write this file?',
			reason: null,
			body: { kind: 'text', text: 'CHANGELOG.md' },
		}));

	it('WebFetch → the whole URL, what it looks for as the reason', () =>
		expect(
			describePermission({
				toolName: 'WebFetch',
				input: { url: 'https://example.com/docs/a-long-page', prompt: 'find the rate limits' },
				summary: 'fetch https://example.com/docs/a-long-page',
			}),
		).toEqual({
			title: 'Open this page?',
			reason: 'find the rate limits',
			body: { kind: 'text', text: 'https://example.com/docs/a-long-page' },
		}));

	it('WebSearch → the query', () =>
		expect(
			describePermission({
				toolName: 'WebSearch',
				input: { query: 'bun test timeout' },
				summary: 'search the web for bun test timeout',
			}).body,
		).toEqual({ kind: 'text', text: 'bun test timeout' }));

	it('an MCP tool → its readable name, and what it was called with as fields', () =>
		expect(
			describePermission({
				toolName: 'mcp__linear__create_issue',
				input: { title: 'Flaky checkout test', priority: 2, labels: ['bug'], team: 'web' },
				summary: 'use linear create_issue',
			}),
		).toEqual({
			title: 'Use linear create_issue?',
			reason: null,
			body: {
				kind: 'fields',
				fields: [
					{ key: 'title', value: 'Flaky checkout test' },
					{ key: 'priority', value: '2' },
					{ key: 'team', value: 'web' },
				],
			},
		}));

	it('an unknown tool with nothing showable → no body', () =>
		expect(
			describePermission({
				toolName: 'Mystery',
				input: { nested: { a: 1 } },
				summary: 'use Mystery',
			}),
		).toEqual({ title: 'Use Mystery?', reason: null, body: null }));
});

describe('describeAlways', () => {
	const rules = (...entries: Record<string, unknown>[]) => ({
		type: 'addRules',
		behavior: 'allow',
		destination: 'localSettings',
		rules: entries,
	});

	it('a Bash rule "npm run test:*" → names the prefix it remembers', () =>
		expect(describeAlways([rules({ toolName: 'Bash', ruleContent: 'npm run test:*' })])).toEqual({
			rule: 'npm run test',
			more: 0,
			title: 'Always allow: npm run test',
		}));

	it('a rule with no content → the tool', () =>
		expect(describeAlways([rules({ toolName: 'Edit' })])?.rule).toBe('Edit'));

	it('several rules → the first, and how many more it grants', () =>
		expect(
			describeAlways([
				rules(
					{ toolName: 'Bash', ruleContent: 'bun test:*' },
					{ toolName: 'Bash', ruleContent: 'git push:*' },
				),
			]),
		).toEqual({ rule: 'bun test', more: 1, title: 'Always allow: bun test, git push' }));

	it('a folder grant → "in" the folder', () =>
		expect(
			describeAlways([
				{ type: 'addDirectories', directories: ['/w/shared'], destination: 'session' },
			]),
		).toEqual({ rule: 'in /w/shared', more: 0, title: 'Always allow: in /w/shared' }));

	it('a long rule → clipped for the button, whole in its title', () => {
		const long = `pnpm --filter ${'x'.repeat(60)} test`;
		const always = describeAlways([rules({ toolName: 'Bash', ruleContent: long })]);

		expect(always?.rule).toHaveLength(40);
		expect(always?.rule?.endsWith('…')).toBe(true);
		expect(always?.title).toBe(`Always allow: ${long}`);
	});

	it('something remembered that has no name → the button, without a rule', () =>
		expect(describeAlways([{ type: 'replaceRules', rules: [] }])).toEqual({
			rule: null,
			more: 0,
			title: 'Always allow this from now on',
		}));

	it('a deny rule → nothing named for "allow": the plain button', () =>
		expect(
			describeAlways([
				{ type: 'addRules', behavior: 'deny', rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }] },
			]),
		).toEqual({ rule: null, more: 0, title: 'Always allow this from now on' }));

	it('only a mode change → no button: "always" never moves the mode', () =>
		expect(
			describeAlways([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]),
		).toBeNull());

	it('no suggestions → no button', () => expect(describeAlways([])).toBeNull());
});

describe('describeConfirm', () => {
	it('/clear → clear, what it keeps, nothing extra to show', () =>
		expect(describeConfirm({ command: 'clear', text: '/clear' })).toEqual({
			title: 'Clear the conversation?',
			reason: 'It starts fresh. Files and commits stay.',
			verb: 'Clear',
			extra: null,
		}));

	it('"/clear " with a trailing space → still nothing extra', () =>
		expect(describeConfirm({ command: 'clear', text: '/clear ' }).extra).toBeNull());

	it('/compact with instructions → they are shown', () =>
		expect(describeConfirm({ command: 'compact', text: '/compact keep the notes' })).toEqual({
			title: 'Compact the conversation?',
			reason: 'It keeps a summary and carries on.',
			verb: 'Compact',
			extra: '/compact keep the notes',
		}));
});

describe('readOptionWord', () => {
	it('the first five options → said by number, as the answer tool takes them', () => {
		expect(readOptionWord(0)).toBe('one');
		expect(readOptionWord(4)).toBe('five');
	});

	it('a sixth option → said by its name', () => expect(readOptionWord(5)).toBeNull());
});

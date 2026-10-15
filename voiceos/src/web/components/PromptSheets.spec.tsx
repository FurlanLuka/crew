// The prompts docked above the voice bar, drawn from an ask: each kind's sheet, its answers and the
// words that answer it by voice. Opening a field inside a sheet is a click: test/ui covers that.
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Denial, PendingAsk } from '../../shared/protocol.js';
import { AskDock } from './AskDock.js';
import { DenialSheet } from './DenialSheet.js';

const noop = () => undefined;
const STORE = 'store-front/main';

const render = (ask: PendingAsk, label = STORE): string =>
	renderToStaticMarkup(<AskDock ask={ask} label={label} dispatch={noop} />);

const permission = (
	patch: Partial<Extract<PendingAsk, { kind: 'permission' }>> = {},
): PendingAsk => ({
	id: 'p1',
	ref: STORE,
	at: 1,
	kind: 'permission',
	toolName: 'Bash',
	summary: 'run bun test e2e/checkout && git push',
	input: {
		command: 'bun test e2e/checkout && git push',
		description: 'Run the checkout tests, then push',
	},
	suggestions: [
		{
			type: 'addRules',
			behavior: 'allow',
			destination: 'localSettings',
			rules: [{ toolName: 'Bash', ruleContent: 'bun test:*' }],
		},
	],
	...patch,
});

const question = (patch: Partial<Extract<PendingAsk, { kind: 'question' }>> = {}): PendingAsk => ({
	id: 'q1',
	ref: STORE,
	at: 1,
	kind: 'question',
	input: {},
	questions: [
		{
			question: 'A new events table, or a column on orders?',
			multiSelect: false,
			options: [
				{ label: 'A new events table', description: 'One row per event' },
				{ label: 'A column on orders' },
			],
		},
	],
	...patch,
});

const buttons = (html: string): string[] =>
	[...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((match) =>
		(match[1] ?? '').replace(/<[^>]+>/g, '').trim(),
	);

describe('the permission sheet', () => {
	it('Bash → asks to run it, says why, the command drawn with its programs and operators', () => {
		const html = render(permission());

		expect(html).toContain('aria-label="permission"');
		expect(html).toContain('class="sheet permission"');
		expect(html).toContain('Run this command?');
		expect(html).toContain('Run the checkout tests, then push');
		expect(html).toContain('<span class="sh-tool">Bash</span>');
		expect(html).toContain(
			'<span class="program">bun</span><span> test e2e/checkout </span><span class="operator">&amp;&amp;</span>',
		);
	});

	it('answers left to right, Allow last; Always names what it remembers', () =>
		expect(buttons(render(permission()))).toEqual([
			'Deny and say why…',
			'Deny',
			'Always allow bun test',
			'Allow',
		]));

	it('the words that answer it by voice, once', () => {
		const html = render(permission());

		expect(html).toContain('<span class="sh-say">Say yes, always or no</span>');
		expect(html).not.toContain('“yes”');
	});

	it('only a mode change to remember → no Always button, and "always" is not offered by voice', () => {
		const html = render(
			permission({
				suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
			}),
		);

		expect(buttons(html)).toEqual(['Deny and say why…', 'Deny', 'Allow']);
		expect(html).toContain('Say yes or no');
	});

	it('two rules → "+1 more", the whole list in its tooltip', () => {
		const html = render(
			permission({
				suggestions: [
					{
						type: 'addRules',
						behavior: 'allow',
						rules: [
							{ toolName: 'Bash', ruleContent: 'bun test:*' },
							{ toolName: 'Bash', ruleContent: 'git push:*' },
						],
					},
				],
			}),
		);

		expect(html).toContain('title="Always allow: bun test, git push"');
		expect(html).toContain('<span class="sh-more">+1 more</span>');
	});

	it('an MCP tool → what it was called with, as names and values; no command box', () => {
		const html = render(
			permission({
				toolName: 'mcp__linear__create_issue',
				summary: 'use linear create_issue',
				input: { title: 'Flaky checkout test', team: 'web' },
				suggestions: [],
			}),
		);

		expect(html).toContain('Use linear create_issue?');
		expect(html).toContain(
			'<dl class="sh-fields"><div><dt>title</dt><dd>Flaky checkout test</dd></div><div><dt>team</dt><dd>web</dd></div></dl>',
		);
		expect(html).not.toContain('sh-cmd');
	});

	it('a tool with nothing to show → just the question and its answers', () =>
		expect(
			render(
				permission({ toolName: 'Mystery', summary: 'use Mystery', input: {}, suggestions: [] }),
			),
		).not.toContain('sh-body'));

	it('something to remember that has no name → "Always allow", nothing after it', () =>
		expect(
			buttons(render(permission({ suggestions: [{ type: 'replaceRules', rules: [] }] }))),
		).toContain('Always allow'));

	it('an edit → asks to edit the file, its path as the body', () => {
		const html = render(
			permission({
				toolName: 'Edit',
				summary: 'edit src/api/orders.ts',
				input: {},
				suggestions: [],
			}),
		);

		expect(html).toContain('Edit this file?');
		expect(html).toContain('<pre class="sh-cmd plain">src/api/orders.ts</pre>');
	});

	it('a setup session → the same answers, nothing to say aloud', () => {
		for (const ref of ['setup', 'vm1:setup']) {
			const html = render(permission({ ref }), 'setup');

			expect(buttons(html)).toContain('Allow');
			expect(html).not.toContain('sh-say');
		}
	});
});

describe('the question sheet', () => {
	it('the question, its options as numbered rows with the word that picks each, then "Something else…"', () => {
		const html = render(question());

		expect(html).toContain('aria-label="question"');
		expect(html).toContain('A new events table, or a column on orders?');
		expect(buttons(html)).toEqual([
			'✕',
			'1A new events tableOne row per event“one”',
			'2A column on orders“two”',
			'Something else…',
		]);
		expect(html).toContain('aria-label="Decline the question"');
		expect(html).toContain('Say an option, or your own answer');
	});

	it('several questions → which one of how many, with a bar each', () => {
		const html = render(
			question({
				questions: [
					{ question: 'First?', multiSelect: false, options: [{ label: 'a' }] },
					{ question: 'Second?', multiSelect: false, options: [{ label: 'b' }] },
				],
				answers: { 'First?': 'a' },
			}),
		);

		expect(html).toContain('Second?');
		expect(html).toContain('2 of 2');
		expect(html.match(/<i class="on"><\/i>/g)).toHaveLength(2);
	});

	it('a multi-select → rows that toggle, and Send, waiting for a pick', () => {
		const html = render(
			question({
				questions: [
					{
						question: 'Which suites?',
						multiSelect: true,
						options: [{ label: 'unit' }, { label: 'e2e' }],
					},
				],
			}),
		);

		expect(html).toContain('aria-pressed="false"');
		expect(html).toMatch(/<button type="button" class="btn primary" disabled="">Send<\/button>/);
	});

	it('a setup session, here or on another machine → no words to say and no foot at all', () => {
		for (const ref of ['setup', 'vm1:setup']) {
			const html = render(question({ ref }), 'setup');

			expect(html).not.toContain('“one”');
			expect(html).not.toContain('sh-foot');
			expect(html).toContain('Something else…');
		}
	});
});

describe('the plan sheet', () => {
	it('the plan to read, Read it all, Change the plan… and Approve last; no ✕', () => {
		const html = render({
			id: 'pl1',
			ref: STORE,
			at: 1,
			kind: 'plan',
			input: {},
			plan: '1. Wait for totals',
		});

		expect(html).toContain('aria-label="plan"');
		expect(html).toContain('Plan ready');
		expect(html).toContain('Wait for totals');
		expect(buttons(html)).toEqual(['Read it all', 'Change the plan…', 'Approve']);
		expect(html).toContain('Say approve, or what to change');
	});
});

describe('the confirm sheet', () => {
	it('/clear → one row: what clearing does, Keep it or Clear', () => {
		const html = render({
			id: 'c1',
			ref: STORE,
			at: 1,
			kind: 'command',
			command: 'clear',
			text: '/clear',
		});

		expect(html).toContain('class="sheet confirm row"');
		expect(html).toContain('Clear the conversation?');
		expect(html).toContain('It starts fresh. Files and commits stay.');
		expect(buttons(html)).toEqual(['Keep it', 'Clear']);
		expect(html).toContain('<span class="sh-say">Say yes or no</span>');
	});

	it('/compact with instructions → they show, and it is no longer one row', () => {
		const html = render({
			id: 'c2',
			ref: STORE,
			at: 1,
			kind: 'command',
			command: 'compact',
			text: '/compact keep the notes',
		});

		expect(html).toContain('<p class="sh-quote">/compact keep the notes</p>');
		expect(html).not.toContain('confirm row');
		expect(buttons(html)).toEqual(['Keep it', 'Compact']);
	});
});

describe('the switch sheet', () => {
	it('your new words, what stopping means, After this or Switch now', () => {
		const html = render({
			id: 'r1',
			ref: STORE,
			at: 1,
			kind: 'redirect',
			text: 'also check the totals on mobile',
			target: null,
		});

		expect(html).toContain('Stop and switch to this?');
		expect(html).toContain('store-front/main stops what it is doing');
		expect(html).toContain('also check the totals on mobile');
		expect(buttons(html)).toEqual(['After this', 'Switch now']);
		expect(html).toContain('Say yes to switch now, or no for after');
	});
});

describe('the sheet for another session', () => {
	const base = {
		ref: 'store',
		at: 1,
		to: 'checkout',
		fromLabel: 'store-front/main',
		toLabel: 'checkout-api/main',
		requestId: 'r1',
	};

	it('work → both sessions, the route, and the task as plain text', () => {
		const html = render({ ...base, id: 'r1:ok', kind: 'work', text: 'run the staging check' });

		expect(html).toContain('aria-label="request from another session"');
		expect(html).toContain('>SF</span>store-front/main');
		expect(html).toContain('to do this and report back');
		expect(html).toContain('<p class="sh-task">run the staging check</p>');
		expect(buttons(html)).toEqual(['No', 'Allow']);
		expect(html).toContain('<span class="sh-say">Say yes or no</span>');
	});

	it("a secret → a lock, the secret's name, and where it goes", () => {
		const html = render({ ...base, id: 'r1:ok', kind: 'secret', what: 'STRIPE_KEY' });

		expect(html).toContain('lock-icon');
		expect(html).toContain('<code>STRIPE_KEY</code>');
		expect(html).toContain('It goes into a private file only store-front/main can read.');
	});
});

describe('the blocked sheet', () => {
	const denial = (ref: string): Denial => ({
		id: 'd1',
		ref,
		toolName: 'Bash',
		summary: 'run rm -rf node_modules/.cache',
		at: 1,
	});

	it('what auto mode stopped, Leave it blocked or Allow once, on one row', () => {
		const html = renderToStaticMarkup(
			<DenialSheet denial={denial(STORE)} label={STORE} dispatch={noop} />,
		);

		expect(html).toContain('aria-label="denied"');
		expect(html).toContain('class="sheet denied row"');
		expect(html).toContain('store-front/main tried to run rm -rf node_modules/.cache');
		expect(buttons(html)).toEqual(['Leave it blocked', 'Allow once']);
		expect(html).toContain('Say allow it');
	});

	it("a setup session's, here or on another machine → nothing to say aloud", () => {
		for (const ref of ['setup', 'vm1:setup']) {
			expect(
				renderToStaticMarkup(<DenialSheet denial={denial(ref)} label="setup" dispatch={noop} />),
			).not.toContain('Say allow it');
		}
	});
});

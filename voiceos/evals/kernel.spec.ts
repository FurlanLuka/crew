import { describe, expect, it } from 'bun:test';
import { judgeRun, findTextProblems } from './kernel.js';

describe('findTextProblems', () => {
	it('every required word must survive the rewrite; "a|b" accepts either', () => {
		expect(
			findTextProblems("Don't touch the migrations.", {
				name: 'forward',
				text_includes: ['not|don', 'migration'],
			}),
		).toEqual({ missing: [], relayed: [] });
		expect(
			findTextProblems('Touch the migrations.', {
				name: 'forward',
				text_includes: ['not|don', 'migration'],
			}).missing,
		).toEqual(['not|don']);
	});
	it('relay words passed on are named, whatever their case', () =>
		expect(
			findTextProblems('Ask it to check the logs.', {
				name: 'forward',
				not_includes: ['ask it', 'tell it'],
			}).relayed,
		).toEqual(['ask it']));
});

describe('judgeRun', () => {
	const checkLogsCase = {
		id: 'x',
		utterance: 'Can you ask it to check the logs?',
		context: {},
		calls: [{ name: 'forward' as const, text_includes: ['log'], not_includes: ['ask it'] }],
	};
	const forward = (text: string) => [{ name: 'forward', input: { text }, ok: true }];

	it('a clean instruction keeping the detail → ok', () =>
		expect(
			judgeRun({ calls: forward('Check the logs.'), reply: '', testCase: checkLogsCase }).ok,
		).toBe(true));

	it('the relay words passed on → fails, naming the phrase and what was sent', () => {
		const verdict = judgeRun({
			calls: forward('Ask it to check the logs.'),
			reply: '',
			testCase: checkLogsCase,
		});
		expect(verdict).toEqual({
			ok: false,
			why: 'missing forward() — sent "Ask it to check the logs." (still saying ask it)',
		});
	});

	it('a required word dropped → fails, naming it', () =>
		expect(
			judgeRun({ calls: forward('Check the output.'), reply: '', testCase: checkLogsCase }).why,
		).toBe('missing forward() — sent "Check the output." (without log)'));

	it('a question with no spoken answer → fails', () => {
		const questionCase = {
			id: 'q',
			utterance: 'what is waiting on me',
			context: {},
			calls: [],
			answer: true,
		};
		expect(
			judgeRun({
				calls: [{ name: 'read_state', input: { ref: null }, ok: true }],
				reply: '',
				testCase: questionCase,
			}),
		).toEqual({ ok: false, why: 'a question got no spoken answer' });
		expect(judgeRun({ calls: [], reply: 'Nothing is waiting.', testCase: questionCase }).ok).toBe(
			true,
		);
	});

	it('silent: any reply or any change fails; saying nothing and doing nothing passes', () => {
		const silentCase = { id: 's', utterance: 'And can you.', context: {}, calls: [], silent: true };
		expect(judgeRun({ calls: [], reply: '', testCase: silentCase }).ok).toBe(true);
		expect(judgeRun({ calls: [], reply: 'Can I what?', testCase: silentCase })).toEqual({
			ok: false,
			why: 'replied to words that ask for nothing: "Can I what?"',
		});
		expect(judgeRun({ calls: forward('And can you.'), reply: '', testCase: silentCase }).ok).toBe(
			false,
		);
	});

	it('a reply over 25 words fails unless the case asked for detail', () => {
		const questionCase = {
			id: 'q',
			utterance: 'what is waiting',
			context: {},
			calls: [],
			answer: true,
		};
		const long = 'word '.repeat(26).trim();
		expect(judgeRun({ calls: [], reply: long, testCase: questionCase }).ok).toBe(false);
		expect(
			judgeRun({ calls: [], reply: long, testCase: { ...questionCase, long_reply: true } }).ok,
		).toBe(true);
	});

	it('reply_includes: every entry must be said ("a|b" either)', () => {
		const optionsCase = {
			id: 'q',
			utterance: 'options',
			context: {},
			calls: [],
			answer: true,
			long_reply: true,
			reply_includes: ['redis', 'lru|in-process'],
		};
		expect(
			judgeRun({
				calls: [],
				reply: '1, Redis for a minute. 2, a nightly job. 3, an in-process cache.',
				testCase: optionsCase,
			}).ok,
		).toBe(true);
		expect(
			judgeRun({ calls: [], reply: '1, Redis. 2, a nightly job.', testCase: optionsCase }),
		).toEqual({
			ok: false,
			why: 'the reply leaves out lru|in-process: "1, Redis. 2, a nightly job."',
		});
	});

	it('reply_not_includes: an invented detail fails', () => {
		const optionsCase = {
			id: 'q',
			utterance: 'options',
			context: {},
			calls: [],
			answer: true,
			reply_not_includes: ['size'],
		};
		expect(
			judgeRun({ calls: [], reply: 'Nothing is waiting on a choice.', testCase: optionsCase }).ok,
		).toBe(true);
		expect(
			judgeRun({ calls: [], reply: 'Sort by size or by name.', testCase: optionsCase }),
		).toEqual({
			ok: false,
			why: 'the reply says size: "Sort by size or by name."',
		});
	});

	it("input: the arguments named must match exactly (an answer's decision, an offer's accept)", () => {
		const answerCase = {
			id: 'a',
			utterance: 'No, use a new branch.',
			context: {},
			calls: [
				{
					name: 'answer' as const,
					ref: 'store-front/wrk1',
					input: { decision: 'no' },
					text_includes: 'branch',
				},
			],
		};
		const answer = (decision: string, text: string) => [
			{ name: 'answer', input: { ref: 'store-front/wrk1', decision, text }, ok: true },
		];
		expect(
			judgeRun({ calls: answer('no', 'Use a new branch.'), reply: '', testCase: answerCase }).ok,
		).toBe(true);
		expect(
			judgeRun({ calls: answer('yes', 'Use a new branch.'), reply: '', testCase: answerCase }),
		).toEqual({
			ok: false,
			why: 'missing answer(store-front/wrk1 {"decision":"no"}) — sent "Use a new branch."',
		});
		const offerCase = {
			id: 'o',
			utterance: 'No.',
			context: {},
			calls: [{ name: 'dev_offer' as const, input: { accept: false } }],
		};
		expect(
			judgeRun({
				calls: [{ name: 'dev_offer', input: { accept: true }, ok: true }],
				reply: '',
				testCase: offerCase,
			}).ok,
		).toBe(false);
	});

	it('the new tools are mutations: an answer nobody asked for fails a case that expects none', () => {
		const hmmCase = { id: 'q', utterance: 'Hmm.', context: {}, calls: [], silent: true };
		expect(
			judgeRun({
				calls: [
					{
						name: 'answer',
						input: { ref: 'store-front/wrk1', decision: 'yes', text: '' },
						ok: true,
					},
				],
				reply: '',
				testCase: hmmCase,
			}).ok,
		).toBe(false);
		const stopCase = {
			id: 'i',
			utterance: 'Stop.',
			context: {},
			calls: [{ name: 'forward' as const }],
		};
		expect(
			judgeRun({
				calls: [...forward('x'), { name: 'interrupt', input: { ref: 'x' }, ok: true }],
				reply: '',
				testCase: stopCase,
			}).why,
		).toContain('unexpected interrupt');
	});

	it('no_reply: the call happens and nothing is said', () => {
		const quietCase = {
			id: 'q',
			utterance: 'Quiet.',
			context: {},
			calls: [{ name: 'mute' as const }],
			no_reply: true,
		};
		const mute = [{ name: 'mute', input: {}, ok: true }];
		expect(judgeRun({ calls: mute, reply: '', testCase: quietCase }).ok).toBe(true);
		expect(judgeRun({ calls: mute, reply: 'Okay, going quiet.', testCase: quietCase })).toEqual({
			ok: false,
			why: 'spoke when asked for quiet: "Okay, going quiet."',
		});
	});
});

import { describe, expect, it } from 'bun:test';
import type { FollowUpFacts } from '../shared/follow-up.js';
import {
	buildFollowUpMessage,
	buildProgressMessage,
	cleanWordedLine,
	composeProgressFallback,
	findFollowUpProblem,
	findProgressProblem,
} from './prompt.js';

const SENT: FollowUpFacts = { kind: 'sent', label: 'checkout, main', offersSwitch: false };
const OFFERED: FollowUpFacts = { ...SENT, offersSwitch: true };

describe('findFollowUpProblem', () => {
	it('a line that keeps every rule → none', () => {
		expect(findFollowUpProblem('Passed that on to checkout, main.', SENT)).toBeNull();
		expect(findFollowUpProblem('Checkout main has it. Want to go there?', OFFERED)).toBeNull();
	});

	it.each<[string, string, FollowUpFacts, string]>([
		['empty', '', SENT, 'empty'],
		['the label changed', 'Passed that on to checkout.', SENT, 'label'],
		[
			'a question nobody offered',
			'Sent to checkout, main. Anything else?',
			SENT,
			'question not offered',
		],
		['a question mark midway', 'Sent to checkout, main? Done.', SENT, 'question not offered'],
		['the offered switch left out', 'Sent to checkout, main.', OFFERED, 'question missing'],
		['the wake word', 'Voice OS sent it to checkout, main.', SENT, 'wake word'],
		['a tag', '[warm] Sent to checkout, main.', SENT, 'tags'],
		[
			'over 25 words',
			`Sent to checkout, main, ${'and then some more words '.repeat(5)}.`,
			SENT,
			'too long',
		],
	])('%s → %s', (_, line, facts, problem) =>
		expect(findFollowUpProblem(line, facts)).toBe(problem),
	);

	it('every session passed over on the way back is named too', () => {
		const back: FollowUpFacts = { kind: 'back', label: 'crew, main', skipped: ['checkout, main'] };

		expect(findFollowUpProblem('Back on crew, main.', back)).toBe('label');
		expect(findFollowUpProblem('Checkout, main stopped, so back on crew, main.', back)).toBeNull();
	});

	it('"after its current work" names no one: the code puts the name in front', () => {
		const queued: FollowUpFacts = { kind: 'queued', label: 'checkout, main', offersSwitch: false };

		expect(findFollowUpProblem('Queued for when it is done.', queued)).toBeNull();
		expect(findFollowUpProblem('Checkout, main gets it after its current work.', queued)).toBe(
			'named',
		);
	});

	it('activation always asks the switch', () =>
		expect(
			findFollowUpProblem('Starting crew, main.', {
				kind: 'activated',
				label: 'crew, main',
				hasWaitingWords: false,
			}),
		).toBe('question missing'));
});

describe('findProgressProblem', () => {
	it.each<[string, string | null]>([
		['Still on it, editing the router now.', null],
		['Still going. Want an update?', 'question'],
		['[sighs] Still going.', 'tags'],
		['', 'empty'],
	])('%p → %p', (line, problem) => expect(findProgressProblem(line)).toBe(problem));
});

describe('the messages', () => {
	it('a follow-up: the facts, whether a switch is offered, the plain line, and the ack just said', () =>
		expect(
			buildFollowUpMessage({
				facts: OFFERED,
				fixedText: 'Sent to checkout, main. Switch there?',
				lastAck: 'Okay.',
			}),
		).toBe(
			[
				'facts: The developer\'s words were passed to the session "checkout, main".',
				'switch offered: yes',
				'plain line: Sent to checkout, main. Switch there?',
				'just said: Okay.',
			].join('\n'),
		));

	it('progress: the step and the sub-agents, nothing else', () =>
		expect(
			buildProgressMessage({
				step: 'edit router.ts',
				agents: ['Find the retry callers'],
				lastProgress: null,
			}),
		).toBe(
			[
				'latest step: edit router.ts',
				'sub-agents: "Find the retry callers"',
				'said last: (nothing)',
			].join('\n'),
		));
});

describe('composeProgressFallback', () => {
	it('plain, and never a guess', () => {
		expect(composeProgressFallback({ agents: [] })).toBe('Still working on it.');
		expect(composeProgressFallback({ agents: ['a'] })).toBe('Still working on it.');
		expect(composeProgressFallback({ agents: ['a', 'b'] })).toBe('Two agents still working.');
	});
});

describe('cleanWordedLine', () => {
	it("the model's own quotes and space come off", () =>
		expect(cleanWordedLine('  "Over to crew."\n')).toBe('Over to crew.'));

	it('quotes kept around the label inside the line → gone; an apostrophe stays', () =>
		expect(cleanWordedLine('Sent to "checkout api, main". It\'s on it.')).toBe(
			"Sent to checkout api, main. It's on it.",
		));
});

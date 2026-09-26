import { describe, expect, it } from 'bun:test';
import type { PendingAsk } from '../shared/protocol.js';
import { buildAnswerActions } from './answer.js';

const permission: PendingAsk = {
	id: 'p1',
	ref: 'x/main',
	at: 1,
	kind: 'permission',
	toolName: 'Bash',
	summary: 'run git push',
	input: {},
	suggestions: [],
};

const plan: PendingAsk = {
	id: 'l1',
	ref: 'x/main',
	at: 1,
	kind: 'plan',
	input: {},
	plan: 'do things',
};

const createQuestion = (count = 1): PendingAsk => ({
	id: 'q1',
	ref: 'x/main',
	at: 1,
	kind: 'question',
	input: {},
	questions: Array.from({ length: count }, (_, i) => ({
		question: `Which ${i}?`,
		multiSelect: false,
		options: [{ label: 'New table' }, { label: 'Reuse orders' }],
	})),
});

describe('buildAnswerActions', () => {
	it('permission: yes allows, always remembers, no denies with the reason; choose is refused', () => {
		expect(buildAnswerActions({ ask: permission, decision: 'yes', text: '' })).toEqual({
			ok: true,
			actions: [{ type: 'answer_permission', askId: 'p1', decision: 'allow' }],
		});
		expect(buildAnswerActions({ ask: permission, decision: 'always', text: '' })).toEqual({
			ok: true,
			actions: [{ type: 'answer_permission', askId: 'p1', decision: 'always' }],
		});
		expect(
			buildAnswerActions({ ask: permission, decision: 'no', text: 'use a new branch' }),
		).toEqual({
			ok: true,
			actions: [
				{ type: 'answer_permission', askId: 'p1', decision: 'deny', message: 'use a new branch' },
			],
		});
		expect(buildAnswerActions({ ask: permission, decision: 'choose', text: 'x' }).ok).toBe(false);
	});

	it('plan: yes approves, no rejects with what to change', () => {
		expect(buildAnswerActions({ ask: plan, decision: 'yes', text: '' })).toEqual({
			ok: true,
			actions: [{ type: 'answer_plan', askId: 'l1', isApproved: true }],
		});
		expect(buildAnswerActions({ ask: plan, decision: 'no', text: 'keep the old schema' })).toEqual({
			ok: true,
			actions: [
				{ type: 'answer_plan', askId: 'l1', isApproved: false, message: 'keep the old schema' },
			],
		});
	});

	it('question: the kernel\'s chosen label or words go in as they are; a bare yes/no becomes "Yes"/"No"', () => {
		expect(
			buildAnswerActions({ ask: createQuestion(), decision: 'choose', text: 'Reuse orders' }),
		).toEqual({
			ok: true,
			actions: [{ type: 'answer_question', askId: 'q1', answers: { 'Which 0?': 'Reuse orders' } }],
		});
		expect(buildAnswerActions({ ask: createQuestion(), decision: 'no', text: '' })).toMatchObject({
			actions: [{ answers: { 'Which 0?': 'No' } }],
		});
	});

	it('words added to a yes follow as a message to the session; a no carries them as its reason instead', () => {
		expect(
			buildAnswerActions({
				ask: permission,
				decision: 'yes',
				text: 'Push to a new branch afterwards.',
			}),
		).toEqual({
			ok: true,
			actions: [
				{ type: 'answer_permission', askId: 'p1', decision: 'allow' },
				{ type: 'send', ref: 'x/main', text: 'Push to a new branch afterwards.' },
			],
		});
		expect(
			buildAnswerActions({ ask: plan, decision: 'yes', text: 'Start with the backfill.' }),
		).toMatchObject({
			actions: [
				{ type: 'answer_plan', isApproved: true },
				{ type: 'send', text: 'Start with the backfill.' },
			],
		});
	});

	it('choose with no words → refused (never a stray "Yes" to a multiple choice); yes with none → "Yes"', () => {
		expect(buildAnswerActions({ ask: createQuestion(), decision: 'choose', text: '  ' }).ok).toBe(
			false,
		);
		expect(buildAnswerActions({ ask: createQuestion(), decision: 'yes', text: '' })).toMatchObject({
			actions: [{ answers: { 'Which 0?': 'Yes' } }],
		});
	});

	it('blank words beside a yes send nothing more', () => {
		expect(buildAnswerActions({ ask: permission, decision: 'yes', text: '   ' })).toEqual({
			ok: true,
			actions: [{ type: 'answer_permission', askId: 'p1', decision: 'allow' }],
		});
	});

	it('"always" on a plan approves it', () => {
		expect(buildAnswerActions({ ask: plan, decision: 'always', text: '' })).toEqual({
			ok: true,
			actions: [{ type: 'answer_plan', askId: 'l1', isApproved: true }],
		});
	});

	it('a question with nothing in it → refused', () => {
		const result = buildAnswerActions({ ask: createQuestion(0), decision: 'choose', text: 'x' });

		expect(result.ok).toBe(false);
	});

	it('several questions → pointed to the screen', () => {
		const result = buildAnswerActions({ ask: createQuestion(2), decision: 'choose', text: 'x' });

		expect(result).toMatchObject({ ok: false, error: expect.stringContaining('on screen') });
	});
});

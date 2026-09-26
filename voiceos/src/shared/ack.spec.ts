import { describe, expect, it } from 'bun:test';
import { composeAckText, joinTasks, mergeOwed, readAckTask, sharesContentWords } from './ack.js';

describe('readAckTask', () => {
	it.each<[string, string, string | null]>([
		['Checking the logs', 'can you check the logs', 'Checking the logs'],
		['Checking the logs.', 'check the logs please', 'Checking the logs'],
		['Running the tests again', 'run the tests again', 'Running the tests again'],
		[
			'Reverting the last change',
			"hmm, I don't like that, revert the last change",
			'Reverting the last change',
		],
		['Checking the log', 'look at the logs and check them', 'Checking the log'],
		['Fixing the API test', 'fix the api test', 'Fixing the API test'],
	])('%p for %p → %p', (ack, utterance, task) => expect(readAckTask(ack, utterance)).toBe(task));

	it.each<[string, unknown, string]>([
		['a word they did not say', 'Reverting the last commit', 'revert the last change'],
		['a verb they did not say', 'Deleting the logs', 'check the logs'],
		['a verb they said not to do', 'Touching the tests', "don't touch the tests, fix the build"],
		['"do not" in two words', 'Touching the tests', 'do not touch the tests'],
		['no -ing verb first', 'The logs', 'check the logs'],
		['a noun ending in -ing', 'Something with the logs', 'something with the logs'],
		['nothing but a pronoun after the verb', 'Doing that', 'do that'],
		[
			'too long',
			'Checking the logs and the tests and the build now',
			'check the logs and the tests and the build now',
		],
		[
			'the verb said "don\'t" later',
			'Running the migrations',
			"run the seed script, but don't run the migrations",
		],
		['a short stem is not the negation', 'Doing the migration', "don't do the migration"],
		['a near-miss noun', 'Reverting the last comment', 'revert the last commit'],
		['missing', undefined, 'check the logs'],
		['empty', '  ', 'check the logs'],
		['not a string', 42, 'check the logs'],
	])('%s → null', (_why, ack, utterance) => expect(readAckTask(ack, utterance)).toBeNull());
});

describe('composeAckText', () => {
	it.each<[string[], 'now' | 'queued' | 'starting', string]>([
		[['Checking the logs'], 'now', 'Checking the logs.'],
		[[], 'now', 'On it.'],
		[['Checking the logs'], 'queued', 'Checking the logs, after its current work.'],
		[[], 'queued', 'Okay, after its current work.'],
		[['Checking the logs'], 'starting', 'Starting it up, then checking the logs.'],
		[[], 'starting', 'Starting it up.'],
		[['Checking the API'], 'starting', 'Starting it up, then checking the API.'],
	])('%p %s → %p', (tasks, timing, text) => expect(composeAckText(tasks, timing)).toBe(text));
});

describe('joinTasks', () => {
	it('several → one phrase, acronyms kept', () => {
		expect(joinTasks(['Checking the logs', 'Running the tests'])).toBe(
			'Checking the logs and running the tests',
		);
		expect(joinTasks(['Checking the logs', 'API docs cleanup'])).toBe(
			'Checking the logs and API docs cleanup',
		);
		expect(joinTasks([])).toBe('');
	});
});

describe('mergeOwed', () => {
	it('tasks in order; nothing owed → null; an unnamed promise still owes', () => {
		expect(
			mergeOwed({ tasks: ['Checking the logs'] }, null, { tasks: ['Running the tests'] }),
		).toEqual({
			tasks: ['Checking the logs', 'Running the tests'],
		});
		expect(mergeOwed(null, undefined)).toBeNull();
		expect(mergeOwed({ tasks: ['a'], ackedAt: 5 }, { tasks: ['b'], ackedAt: 9 })).toEqual({
			tasks: ['a', 'b'],
			ackedAt: 9,
		});
		expect(mergeOwed({ tasks: [] })).toEqual({ tasks: [] });
	});
});

describe('sharesContentWords', () => {
	it('the report names the task when its words are there', () => {
		expect(sharesContentWords('The logs show three timeouts.', 'Checking the logs')).toBe(true);
		expect(sharesContentWords('Three timeouts in the last hour.', 'Checking the logs')).toBe(false);
	});
});

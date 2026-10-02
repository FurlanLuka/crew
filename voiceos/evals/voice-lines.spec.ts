import { describe, expect, it } from 'bun:test';
import {
	checkCaseLine,
	findVoiceLineCaseProblems,
	loadVoiceLineCases,
	scoreVoiceLines,
	type VoiceLineCase,
} from './voice-lines.js';

const cases = loadVoiceLineCases(import.meta.dir);

describe('the voice-lines cases', () => {
	it('every one a line the app could ask for', () => {
		expect(cases.length).toBeGreaterThanOrEqual(15);
		expect(findVoiceLineCaseProblems(cases)).toEqual([]);
	});

	it('every follow-up kind, with and without the switch offered', () => {
		const kinds = new Set(cases.map((testCase) => testCase.facts.kind));

		expect([...kinds].sort()).toEqual(['activated', 'back', 'queued', 'sent', 'switching']);
	});

	it('a broken case is caught before any paid call', () => {
		const [first] = cases;
		const broken: VoiceLineCase[] = [
			{
				id: 'dup',
				kind: 'follow_up',
				facts: { kind: 'sent', label: 'checkout api, main', offersSwitch: true },
				fixedText: 'Sent to checkout api, main.',
				lastAck: 'Hello.',
			},
			{
				id: 'dup',
				kind: 'follow_up',
				facts: { kind: 'sent', label: 'signals, main', offersSwitch: false },
				fixedText: 'Sent to signals, main.',
				lastAck: null,
			},
		];

		expect(first).toBeDefined();
		expect(findVoiceLineCaseProblems(broken)).toEqual([
			'dup: its fixed line breaks a rule (question missing)',
			'dup: lastAck "Hello." is not a pool line',
			'dup: id used twice',
		]);
	});
});

describe('checkCaseLine', () => {
	const sent: VoiceLineCase = {
		id: 'sent',
		kind: 'follow_up',
		facts: { kind: 'sent', label: 'signals, main', offersSwitch: false },
		fixedText: 'Sent to signals, main.',
		lastAck: 'Okay.',
		not_starts: ['okay'],
	};

	it.each([
		['Passed that to signals, main.', null],
		['Okay, passed that to signals, main.', 'opens with "okay" again'],
		['Sent to signals, main, and it is done.', 'invented "done"'],
		['Sent to signals, main; the tests pass.', 'invented "pass"'],
		['Sent to signals, main in 2 seconds.', 'invented "seconds"'],
	])('%p → %p', (line, problem) => expect(checkCaseLine(sent, line)).toBe(problem));

	it('includes: a stem, either way it is put', () => {
		const including: VoiceLineCase = { ...sent, includes: ['pass|sent'] };

		expect(checkCaseLine(including, 'Passed that to signals, main.')).toBeNull();
		expect(checkCaseLine(including, 'Sent to signals, main.')).toBeNull();
		expect(checkCaseLine(including, 'Signals, main has it.')).toBe('missing "pass|sent"');
	});
});

describe('scoreVoiceLines', () => {
	it('passes over answered runs; failed calls counted apart', () =>
		expect(
			scoreVoiceLines([
				{
					id: 'a',
					kind: 'follow_up',
					runs: [
						{ line: 'x', problem: null, ms: 100 },
						{ line: 'y', problem: 'label', ms: 300 },
						{ line: null, problem: 'overloaded', ms: 0 },
					],
				},
			]),
		).toEqual({ n: 2, passRate: 0.5, infraErrors: 1, medianMs: 300 }));
});

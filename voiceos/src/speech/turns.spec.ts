import { describe, expect, it } from 'bun:test';
import { decideTurnAction, isUnfinished, joinTurns } from './turns.js';

describe('isUnfinished', () => {
	it.each([
		// The fragments from the first hands-free session.
		'And can you.',
		'Signals main—',
		"Let's, um.",
		'Why—',
		'I.',
		'Okay. Can you—',
		// Dashes and ellipses in every form speech-to-text writes them.
		'switch to –',
		'switch to -',
		'switch to...',
		'switch to…',
		'Let’s',
		'AND CAN YOU.  ',
		'And can you?',
		'Uh, um.',
		'Um?',
		'restart the servers and',
	])('%p → unfinished', (text) => expect(isUnfinished(text)).toBe(true));

	it.each([
		'Fix this.',
		'Turn it on.',
		'Log in.',
		'Hold on.',
		'I think so.',
		'Okay then.',
		'Plan A.',
		"I'd like to.",
		'Thank you.',
		'What are you up to?',
		'Can you check the logs?',
		'Open store-front.',
		'Show me the follow-up',
		'Okay.',
		'Yes.',
		'',
		'   ',
	])('%p → finished', (text) => expect(isUnfinished(text)).toBe(false));

	// Short answers and commands are whole turns: holding them would delay every reply.
	it('short answers and commands are never unfinished', () => {
		const phrases = [
			...[
				'yes',
				'yeah',
				'yep',
				'yup',
				'sure',
				'ok',
				'okay',
				'allow',
				'allow it',
				'approve',
				'approved',
				'do it',
				'go ahead',
				'go for it',
				'sounds good',
				'looks good',
				'ship it',
				'please do',
				'yes please',
			],
			...['always', 'always allow', 'allow always', 'yes always', 'always yes'],
			...['no', 'nope', 'nah', 'deny', 'denied', "don't", 'do not', 'reject'],
			...[
				'home',
				'go home',
				'mission control',
				'show me everything',
				'show everything',
				'go back',
				'back',
				'escape',
				'overview',
				'all sessions',
			],
			...['quiet', 'be quiet', 'shut up', 'mute', 'hush', 'silence'],
			...['stop', 'stop it', 'cancel', 'cancel that', 'halt', 'abort', 'hold on', 'wait'],
			...['allow that', 'let it', 'yes allow it'],
		];
		expect(phrases.filter((phrase) => isUnfinished(`${phrase}.`))).toEqual([]);
	});
});

describe('joinTurns', () => {
	it('the held part loses its trailing dash, ellipsis or period', () => {
		expect(joinTurns('Switch to—', 'checkout api main.')).toBe('Switch to checkout api main.');
		expect(joinTurns('And can you.', 'Restart the dev servers?')).toBe(
			'And can you restart the dev servers?',
		);
		expect(joinTurns('Tell me about', 'API keys')).toBe('Tell me about API keys');
		expect(joinTurns("Let's, um…", 'open checkout')).toBe("Let's, um open checkout");
	});
});

describe('decideTurnAction', () => {
	const decide = (text: string, held: string | null = null) => decideTurnAction({ held, text });

	it('an unfinished turn waits', () =>
		expect(decide('And can you.')).toEqual({ kind: 'hold', text: 'And can you.' }));
	it('a finished one goes on', () =>
		expect(decide('Run the tests.')).toEqual({ kind: 'route', text: 'Run the tests.' }));
	it('joined to what was held, it goes on as one sentence', () =>
		expect(decide('Restart the dev servers?', 'And can you.')).toEqual({
			kind: 'route',
			text: 'And can you restart the dev servers?',
		}));
	it('joined but still unfinished → waits again', () =>
		expect(decide('and', "Let's, um.")).toEqual({ kind: 'hold', text: "Let's, um and" }));
	it('finished commands go at once; one cut off mid-way waits for the rest', () => {
		expect(decide('Hold on.').kind).toBe('route');
		expect(decide('Show me everything.').kind).toBe('route');
		expect(decide('Stop and').kind).toBe('hold');
		expect(decide('Show me everything—').kind).toBe('hold');
	});

	// Written with a dash, said as "stop": it goes at once.
	it.each(['Hold on—', 'Stop…', 'Wait...'])('%p interrupts at once, never waits', (text) =>
		expect(decide(text).kind).toBe('route'),
	);
});

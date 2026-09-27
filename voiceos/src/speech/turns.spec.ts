import { describe, expect, it } from 'bun:test';
import { decideTurnAction, hasRealWords, isUnfinished, joinTurns } from './turns.js';

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
		// A request cut off before its object: "Can you set up… a workspace?"
		'Can you set up.',
		'Could you look into?',
		'Would you check out',
		'Can you help with.',
		// Complete but held too; the hold ends after 5 s or with the next words, so it is only delayed.
		'Can you clean up?',
		'So how hard would it be to.',
		'Let me tell you about.',
		'We could build it with.',
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
		'We have to.',
		'What is it for?',
		'Where does it come from?',
		'Thank you.',
		'What are you up to?',
		'Can you check the logs?',
		'Can you push?',
		'Could you revert it?',
		'Can you help?',
		'Can you set it up?',
		'Can you set up the workspace?',
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
		expect(joinTurns('Can you set up.', 'A workspace?')).toBe('Can you set up a workspace?');
		expect(joinTurns('And', 'I think so.')).toBe('And I think so.');
		expect(joinTurns("Let's, um…", 'open checkout')).toBe("Let's, um open checkout");
	});
});

describe('decideTurnAction', () => {
	const decide = (text: string, held: string | null = null, heldKind: 'hold' | 'settle' = 'hold') =>
		decideTurnAction({ held, heldKind, text });

	it('an unfinished turn waits for the rest', () =>
		expect(decide('And can you.')).toEqual({ kind: 'hold', text: 'And can you.' }));
	it('a finished one settles: it waits a moment in case the developer goes on', () =>
		expect(decide('Run the tests.')).toEqual({ kind: 'settle', text: 'Run the tests.' }));
	it('joined to an unfinished start, it becomes one sentence', () =>
		expect(decide('Restart the dev servers?', 'And can you.')).toEqual({
			kind: 'settle',
			text: 'And can you restart the dev servers?',
		}));
	it('a request held before its object, joined to the rest → one request', () =>
		expect(decide('A workspace?', 'Can you set up.')).toEqual({
			kind: 'settle',
			text: 'Can you set up a workspace?',
		}));
	it('joined to a finished sentence, the boundary stays: two quick commands stay two sentences', () =>
		expect(decide('Open store front.', 'Go home.', 'settle')).toEqual({
			kind: 'settle',
			text: 'Go home. Open store front.',
		}));
	it('a correction after a finished command joins it, so the kernel sees what it corrects', () =>
		expect(decide('Wait, no, not yet.', 'Push it.', 'settle')).toEqual({
			kind: 'settle',
			text: 'Push it. Wait, no, not yet.',
		}));
	it('joined but still unfinished → waits again', () =>
		expect(decide('and', "Let's, um.")).toEqual({ kind: 'hold', text: "Let's, um and" }));
	it.each(['Stop.', 'Cancel that.', 'Never mind.', 'Stop—'])(
		'%p right after an unsent command → it is dropped, and the word itself goes',
		(text) => expect(decide(text, 'Push the branch.', 'settle')).toEqual({ kind: 'cancel', text }),
	);
	it.each(['Wait.', 'Hold on.'])(
		'%p right after a finished command joins it, never cancels',
		(word) =>
			expect(decide(word, 'Push it.', 'settle')).toEqual({
				kind: 'settle',
				text: `Push it. ${word}`,
			}),
	);
	it('"stop" after an unfinished start drops it too', () =>
		expect(decide('Stop.', 'Switch to—', 'hold')).toEqual({ kind: 'cancel', text: 'Stop.' }));
	it('a finished sentence without its period still ends before the next', () =>
		expect(decide('open store front', 'go home', 'settle').text).toBe('go home. open store front'));
	it('one ending in a comma gets a period, not both', () =>
		expect(decide('open store front', 'Go home,', 'settle').text).toBe(
			'Go home. open store front',
		));
	it('with nothing waiting, interrupts go at once; one cut off mid-way waits for the rest', () => {
		expect(decide('Hold on.').kind).toBe('route');
		expect(decide('Stop.').kind).toBe('route');
		expect(decide('Show me everything.').kind).toBe('settle');
		expect(decide('Stop and').kind).toBe('hold');
		expect(decide('Show me everything—').kind).toBe('hold');
	});

	// Written with a dash, said as "stop": it goes at once.
	it.each(['Hold on—', 'Stop…', 'Wait...'])('%p interrupts at once, never waits', (text) =>
		expect(decide(text).kind).toBe('route'),
	);
});

describe('hasRealWords', () => {
	it.each(['Hmmm.', 'Mhm.', 'Uh-huh.'])('%p is a murmur, not speech going on', (text) =>
		expect(hasRealWords(text)).toBe(false),
	);

	it('a breath or an "mm" is not speech going on; a word is', () => {
		expect(hasRealWords('Mm.')).toBe(false);
		expect(hasRealWords('um, uh')).toBe(false);
		expect(hasRealWords('and')).toBe(true);
		expect(hasRealWords('store-front')).toBe(true);
	});
});

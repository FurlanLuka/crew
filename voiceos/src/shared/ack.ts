// What Voice OS says when it passes an instruction to a session, and the report it then owes.

export type SendTiming = 'now' | 'queued' | 'starting';

export interface ReportOwed {
	// The developer's own words for each task ("Checking the logs"); empty when the kernel gave none.
	tasks: string[];
}

export interface SendAck {
	// null: the kernel's phrase was missing or did not keep to the developer's words.
	task: string | null;
	kind: 'question' | 'instruction';
}

const MAX_TASK_WORDS = 7;
const VERB_STEM_CHARS = 3;

const FILLER_WORDS = new Set([
	'a',
	'an',
	'the',
	'to',
	'of',
	'in',
	'on',
	'at',
	'for',
	'and',
	'or',
	'with',
	'from',
	'into',
	'about',
	'up',
	'out',
	'it',
	'its',
	'this',
	'that',
	'these',
	'those',
	'them',
	'they',
	'my',
	'your',
	'our',
	'me',
	'you',
	'we',
	'i',
	'what',
	'why',
	'how',
	'which',
	'is',
	'are',
	'again',
]);

const NOT_VERBS = new Set(['thing', 'something', 'nothing', 'anything', 'everything']);
const NEGATION_PATTERN = /^(?:don't|dont|not|never|doesn't|didn't)$/;

const toWords = (text: string): string[] =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9'\s-]/g, ' ')
		.split(/\s+/)
		.filter(Boolean);

// "logs" and "log", "tests" and "testing" are one word said differently; "comment" is not "commit".
const matches = (said: string, word: string): boolean =>
	said.startsWith(word) || word.startsWith(said);

const isContentWord = (word: string): boolean => !FILLER_WORDS.has(word);

export const sharesContentWords = (text: string, task: string): boolean => {
	// The narrator's line already names the task when its content words are there.
	const spoken = toWords(text).filter(isContentWord);
	const content = toWords(task).slice(1).filter(isContentWord);

	return content.length > 0 && content.every((word) => spoken.some((said) => matches(said, word)));
};

const isNegation = (word: string): boolean => NEGATION_PATTERN.test(word);

const findVerbIndexes = (said: string[], verb: string): number[] => {
	const stem = verb.slice(0, -'ing'.length).slice(0, VERB_STEM_CHARS);

	return said.flatMap((word, index) => (!isNegation(word) && word.startsWith(stem) ? [index] : []));
};

export const readAckTask = (ack: unknown, utterance: string): string | null => {
	// Every word must be one the developer said: a paraphrase ("Reverting the last commit" for
	// "revert the last change") would confirm something they did not ask for.
	if (typeof ack !== 'string') {
		return null;
	}

	const task = ack.trim().replace(/[.!?,;:]+$/, '');
	const [verb = '', ...rest] = toWords(task);
	const said = toWords(utterance);
	const content = rest.filter(isContentWord);

	if (
		!verb.endsWith('ing') ||
		NOT_VERBS.has(verb) ||
		rest.length + 1 > MAX_TASK_WORDS ||
		content.length === 0
	) {
		return null;
	}

	// "run the seeds, but don't run the migrations": a verb said anywhere as "don't" is left alone.
	const verbIndexes = findVerbIndexes(said, verb);

	if (verbIndexes.length === 0 || verbIndexes.some((index) => isNegation(said[index - 1] ?? ''))) {
		return null;
	}

	const saidContent = said.filter(isContentWord);

	return content.every((word) => saidContent.some((saidWord) => matches(saidWord, word)))
		? task
		: null;
};

export const lowerFirst = (text: string): string =>
	// "API checks" stays as said: only a word that reads lowercase after its first letter is lowered.
	/^[A-Z][a-z]/.test(text) ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;

export const upperFirst = (text: string): string =>
	`${text.charAt(0).toUpperCase()}${text.slice(1)}`;

export const joinTasks = (tasks: string[]): string => {
	const [first = '', ...rest] = tasks;

	return rest.length ? `${first} and ${rest.map(lowerFirst).join(' and ')}` : first;
};

export const composeAckText = (tasks: string[], timing: SendTiming): string => {
	const task = joinTasks(tasks);

	switch (timing) {
		case 'now':
			return task ? `${upperFirst(task)}.` : 'On it.';
		case 'queued':
			return task
				? `${upperFirst(task)}, after its current work.`
				: 'Okay, after its current work.';
		case 'starting':
			return task ? `Starting it up, then ${lowerFirst(task)}.` : 'Starting it up.';
	}
};

export const mergeOwed = (...owed: (ReportOwed | null | undefined)[]): ReportOwed | null => {
	const present = owed.filter((entry): entry is ReportOwed => Boolean(entry));

	return present.length ? { tasks: present.flatMap((entry) => entry.tasks) } : null;
};

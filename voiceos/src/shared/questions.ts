import type { PendingAsk } from './protocol.js';

export type QuestionAsk = Extract<PendingAsk, { kind: 'question' }>;

type Question = QuestionAsk['questions'][number];

export interface OpenQuestion {
	question: Question;
	index: number;
}

export const readOpenQuestions = (ask: QuestionAsk): Question[] => {
	// An answer counts only when its question's key is there: several are answered one at a time.
	const answers = ask.answers ?? {};

	return ask.questions.filter((entry) => !(entry.question in answers));
};

export const findOpenQuestion = (ask: QuestionAsk): OpenQuestion | null => {
	// Answered in order, like the page: the first without an answer is the one asked now.
	const [question] = readOpenQuestions(ask);

	return question ? { question, index: ask.questions.indexOf(question) } : null;
};

export const hasOpenQuestionMoved = (heard: PendingAsk, live: PendingAsk): boolean =>
	// Answered meanwhile (a click, or an earlier call this turn): words heard for the old one are not for the next.
	heard.kind === 'question' &&
	live.kind === 'question' &&
	findOpenQuestion(heard)?.index !== findOpenQuestion(live)?.index;

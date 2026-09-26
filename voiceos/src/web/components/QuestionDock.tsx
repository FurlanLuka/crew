import { useState } from 'react';
import type { PendingAsk } from '../../shared/protocol.js';
import type { Dispatch } from '../types.js';
import { Reason } from './Reason.js';

type QuestionAsk = Extract<PendingAsk, { kind: 'question' }>;

interface QuestionDockProps {
	ask: QuestionAsk;
	label: string;
	dispatch: Dispatch;
}

export const QuestionDock = ({ ask, label, dispatch }: QuestionDockProps) => {
	const [answers, setAnswers] = useState<Record<string, string>>({});
	const index = ask.questions.findIndex((entry) => !(entry.question in answers));
	const question = ask.questions[index === -1 ? ask.questions.length - 1 : index];

	const handleChoose = (value: string) => {
		if (!question) {
			return;
		}

		const nextAnswers = { ...answers, [question.question]: value };

		if (Object.keys(nextAnswers).length >= ask.questions.length) {
			dispatch({ type: 'answer_question', askId: ask.id, answers: nextAnswers });

			return;
		}

		setAnswers(nextAnswers);
	};

	if (!question) {
		return null;
	}

	return (
		<section className="dock cyan" aria-label="question">
			<span className="lbl c-cyan">
				question · {label}
				{ask.questions.length > 1 && ` · ${index + 1} of ${ask.questions.length}`}
			</span>
			<div className="ask">{question.question}</div>
			<div className="opts">
				{question.options.map((option, optionIndex) => (
					<button
						type="button"
						key={option.label}
						className="opt"
						onClick={() => handleChoose(option.label)}
					>
						<span className="k">{optionIndex + 1}</span>
						<span className="l">{option.label}</span>
						{option.description && <span className="d">{option.description}</span>}
					</button>
				))}
			</div>
			<div className="hint">
				Say <b>“{question.options.length > 1 ? 'two' : 'one'}”</b>, an option's name, or click.
				Anything else is sent as your own answer.
			</div>
			<Reason label="Your own answer…" onSubmit={handleChoose} />
		</section>
	);
};

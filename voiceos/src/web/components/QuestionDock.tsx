import type { Dispatch } from '../types.js';
import { findOpenQuestion, type QuestionAsk } from '../../shared/questions.js';
import { Reason } from './Reason.js';

interface QuestionDockProps {
	ask: QuestionAsk;
	label: string;
	dispatch: Dispatch;
}

export const QuestionDock = ({ ask, label, dispatch }: QuestionDockProps) => {
	// Answers live on the server, so one given by voice shows here too.
	const open = findOpenQuestion(ask);

	if (!open) {
		return null;
	}

	const { question, index } = open;

	const handleChoose = (value: string) => {
		dispatch({ type: 'answer_question', askId: ask.id, answers: { [question.question]: value } });
	};

	return (
		<section className="dock question" aria-label="question">
			<div className="dock-head">
				<span className="lbl">
					question · {label}
					{ask.questions.length > 1 && ` · ${index + 1} of ${ask.questions.length}`}
				</span>
				<button
					type="button"
					className="btn sm ghost decline"
					aria-label="Decline the question"
					title="Decline the question"
					onClick={() => dispatch({ type: 'decline_question', askId: ask.id })}
				>
					✕
				</button>
			</div>
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

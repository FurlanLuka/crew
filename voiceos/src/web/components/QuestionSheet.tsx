import { useState } from 'react';
import { isSetupRef } from '../../shared/machine-ref.js';
import type { Dispatch } from '../types.js';
import { findOpenQuestion, type QuestionAsk } from '../../shared/questions.js';
import { readOptionWord, SAY } from '../prompts.js';
import { PencilIcon } from './icons.js';
import { OwnAnswer, Sheet, SheetFoot, useOwnAnswer } from './PromptSheet.js';

interface QuestionSheetProps {
	ask: QuestionAsk;
	dispatch: Dispatch;
}

type Question = QuestionAsk['questions'][number];

interface QuestionBodyProps {
	ask: QuestionAsk;
	question: Question;
	dispatch: Dispatch;
}

// Several answers to one question go back as the SDK reads a multi-select: labels joined by ", ".
const MULTI_SEPARATOR = ', ';

const QuestionBody = ({ ask, question, dispatch }: QuestionBodyProps) => {
	const own = useOwnAnswer();
	const [picked, setPicked] = useState<string[]>([]);
	const isSpeakable = !isSetupRef(ask.ref);

	const handleAnswer = (value: string) =>
		dispatch({ type: 'answer_question', askId: ask.id, answers: { [question.question]: value } });

	const handleOption = (label: string) => {
		if (!question.multiSelect) {
			handleAnswer(label);

			return;
		}

		setPicked(
			picked.includes(label) ? picked.filter((item) => item !== label) : [...picked, label],
		);
	};

	// Sent in the order the options are listed, whatever order they were picked in.
	const pickedInOrder = question.options
		.map((option) => option.label)
		.filter((label) => picked.includes(label));

	return (
		<>
			<div className="sh-body sh-options">
				{question.options.map((option, optionIndex) => {
					const isPicked = picked.includes(option.label);
					const word = isSpeakable ? readOptionWord(optionIndex) : null;

					return (
						<button
							type="button"
							key={option.label}
							className={isPicked ? 'sh-option picked' : 'sh-option'}
							aria-pressed={question.multiSelect ? isPicked : undefined}
							onClick={() => handleOption(option.label)}
						>
							<span className="k" aria-hidden="true">
								{question.multiSelect ? (isPicked ? '✓' : '') : optionIndex + 1}
							</span>
							<span className="l">
								<b>{option.label}</b>
								{option.description ? <span>{option.description}</span> : null}
							</span>
							{word ? <span className="w">“{word}”</span> : null}
						</button>
					);
				})}
				{own.isOpen ? null : (
					<button type="button" className="sh-option else" ref={own.openerRef} onClick={own.open}>
						<span className="k" aria-hidden="true">
							<PencilIcon />
						</span>
						<span className="l">Something else…</span>
					</button>
				)}
			</div>
			{own.isOpen ? (
				<OwnAnswer
					placeholder="Your own answer"
					submitLabel="Answer"
					onSubmit={handleAnswer}
					onCancel={own.cancel}
				/>
			) : question.multiSelect || isSpeakable ? (
				<SheetFoot sessionRef={ask.ref} say={SAY.question}>
					{question.multiSelect ? (
						<button
							type="button"
							className="btn primary"
							disabled={pickedInOrder.length === 0}
							onClick={() => handleAnswer(pickedInOrder.join(MULTI_SEPARATOR))}
						>
							Send
						</button>
					) : null}
				</SheetFoot>
			) : null}
		</>
	);
};

export const QuestionSheet = ({ ask, dispatch }: QuestionSheetProps) => {
	// Answers live on the server, so one given by voice shows here too.
	const open = findOpenQuestion(ask);

	if (!open) {
		return null;
	}

	const { question, index } = open;
	const total = ask.questions.length;

	return (
		<Sheet
			kind="question"
			label="question"
			tone="plain"
			title={question.question}
			meta={
				<>
					{total > 1 ? (
						<span className="sh-steps">
							{index + 1} of {total}
							<span aria-hidden="true">
								{ask.questions.map((entry, entryIndex) => (
									<i key={entry.question} className={entryIndex <= index ? 'on' : undefined} />
								))}
							</span>
						</span>
					) : null}
					<button
						type="button"
						className="btn sm ghost sh-x"
						aria-label="Decline the question"
						title="Decline the question"
						onClick={() => dispatch({ type: 'decline_question', askId: ask.id })}
					>
						✕
					</button>
				</>
			}
		>
			{/* Each question of a several-question ask starts with its field closed and nothing picked. */}
			<QuestionBody key={`${ask.id}:${index}`} ask={ask} question={question} dispatch={dispatch} />
		</Sheet>
	);
};

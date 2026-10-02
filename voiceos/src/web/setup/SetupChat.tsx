// The machine's setup session, as Voice OS draws a session: your words after ›, Claude's replies,
// each step as an amber ▸ line, a green "✓ recorded" under every crew command that recorded
// something, and its questions as answer cards. Never spoken: Voice OS does not show it.
import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { PendingAsk } from '../../shared/protocol.js';
import { stripStreamingTag } from '../../shared/spoken-tags.js';
import { findOpenQuestion } from '../../shared/questions.js';
import { Markdown } from '../components/Markdown.js';
import { StreamLine } from '../components/StreamLine.js';
import { useStickToBottom } from '../use-stick-to-bottom.js';
import type { SetupContext } from './common.js';
import { listRecordedLines } from './recorded.js';
import { setupRefFor } from './SetupShell.js';

interface SetupChatProps {
	ctx: SetupContext;
	// A request handed over from a Fix/Ask button: filled in, ready to send or edit.
	draft: string;
	onDraftUsed: () => void;
}

interface AnswerCardProps {
	ask: PendingAsk;
	ctx: SetupContext;
	onOwnWords: (askId: string) => void;
}

const AnswerCard = ({ ask, ctx, onOwnWords }: AnswerCardProps) => {
	const dispatch = ctx.send;

	if (ask.kind === 'question') {
		const open = findOpenQuestion(ask);

		if (!open) {
			return null;
		}

		const { question } = open;

		return (
			<div className="ask-card" data-ask="question">
				{question.header && <span className="label">{question.header}</span>}
				<p>{question.question}</p>
				<div className="ask-opts">
					{question.options.map((option) => (
						<button
							key={option.label}
							type="button"
							className="ask-opt"
							onClick={() =>
								dispatch({
									type: 'action',
									action: {
										type: 'answer_question',
										askId: ask.id,
										answers: { [question.question]: option.label },
									},
								})
							}
						>
							<b>{option.label}</b>
							{option.description && <small>{option.description}</small>}
						</button>
					))}
					<button type="button" className="ask-opt other" onClick={() => onOwnWords(ask.id)}>
						<b>Something else…</b>
						<small>Answer in your own words</small>
					</button>
				</div>
			</div>
		);
	}

	if (ask.kind === 'permission') {
		const command = typeof ask.input.command === 'string' ? ask.input.command : null;

		return (
			<div className="ask-card" data-ask="permission">
				<span className="label">Permission · {ask.toolName}</span>
				<p>Setup wants to {ask.summary}.</p>
				{command && <pre className="log">{command}</pre>}
				<div className="row-actions">
					<button
						type="button"
						className="btn primary"
						onClick={() =>
							dispatch({
								type: 'action',
								action: { type: 'answer_permission', askId: ask.id, decision: 'allow' },
							})
						}
					>
						Allow
					</button>
					{ask.suggestions.length > 0 && (
						<button
							type="button"
							className="btn"
							onClick={() =>
								dispatch({
									type: 'action',
									action: { type: 'answer_permission', askId: ask.id, decision: 'always' },
								})
							}
						>
							Always for this
						</button>
					)}
					<button
						type="button"
						className="btn danger"
						onClick={() =>
							dispatch({
								type: 'action',
								action: { type: 'answer_permission', askId: ask.id, decision: 'deny' },
							})
						}
					>
						No
					</button>
				</div>
			</div>
		);
	}

	if (ask.kind === 'plan') {
		return (
			<div className="ask-card" data-ask="plan">
				<span className="label">Plan</span>
				<div className="md-quote">
					<Markdown text={ask.plan} />
				</div>
				<div className="row-actions">
					<button
						type="button"
						className="btn primary"
						onClick={() =>
							dispatch({
								type: 'action',
								action: { type: 'answer_plan', askId: ask.id, isApproved: true },
							})
						}
					>
						Approve
					</button>
					<button type="button" className="btn" onClick={() => onOwnWords(ask.id)}>
						Change the plan…
					</button>
				</div>
			</div>
		);
	}

	if (ask.kind === 'command') {
		return (
			<div className="ask-card" data-ask="confirm">
				<p>{ask.command === 'clear' ? 'Clear' : 'Compact'} setup's context?</p>
				<div className="row-actions">
					<button
						type="button"
						className="btn primary"
						onClick={() =>
							dispatch({
								type: 'action',
								action: { type: 'answer_command', askId: ask.id, isApproved: true },
							})
						}
					>
						Yes
					</button>
					<button
						type="button"
						className="btn"
						onClick={() =>
							dispatch({
								type: 'action',
								action: { type: 'answer_command', askId: ask.id, isApproved: false },
							})
						}
					>
						No
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="ask-card" data-ask="switch">
			<p>Stop what setup is doing and switch to this?</p>
			<pre className="log">{ask.text}</pre>
			<div className="row-actions">
				<button
					type="button"
					className="btn primary"
					onClick={() =>
						dispatch({
							type: 'action',
							action: { type: 'answer_redirect', askId: ask.id, isApproved: true },
						})
					}
				>
					Switch
				</button>
				<button
					type="button"
					className="btn"
					onClick={() =>
						dispatch({
							type: 'action',
							action: { type: 'answer_redirect', askId: ask.id, isApproved: false },
						})
					}
				>
					After
				</button>
			</div>
		</div>
	);
};

export const SetupChat = ({ ctx, draft, onDraftUsed }: SetupChatProps) => {
	const ref = setupRefFor(ctx.machine);
	const session = ctx.state.sessions[ref];
	const asks = ctx.state.asks.filter((ask) => ask.ref === ref);
	const streamRef = useStickToBottom<HTMLDivElement>(ref);
	const [text, setText] = useState(draft);
	const [answering, setAnswering] = useState<string | null>(null);
	const fieldRef = useRef<HTMLInputElement | null>(null);
	const recorded = listRecordedLines(session?.stream ?? []);
	const answeringAsk = asks.find((ask) => ask.id === answering);

	useEffect(() => {
		if (draft) {
			onDraftUsed();
			fieldRef.current?.focus();
		}
	}, []);

	const submit = (event: FormEvent) => {
		event.preventDefault();
		const words = text.trim();

		if (!words) {
			return;
		}

		if (answeringAsk?.kind === 'question') {
			const open = findOpenQuestion(answeringAsk);

			if (open) {
				ctx.send({
					type: 'action',
					action: {
						type: 'answer_question',
						askId: answeringAsk.id,
						answers: { [open.question.question]: words },
					},
				});
			}
		} else if (answeringAsk?.kind === 'plan') {
			ctx.send({
				type: 'action',
				action: { type: 'answer_plan', askId: answeringAsk.id, isApproved: false, message: words },
			});
		} else {
			ctx.send({ type: 'action', action: { type: 'send', ref, text: words } });
		}

		setText('');
		setAnswering(null);
	};

	const isWorking = session?.status === 'running' || session?.status === 'blocked';
	const draftText = session ? stripStreamingTag(session.draft) : '';

	return (
		<section className="page chatpage" aria-label="Setup with Claude">
			<div className="head-row">
				<div className="head-text">
					<h1>Setup with Claude</h1>
					<p className="lead">{ctx.machineTitle} · always on, one conversation</p>
				</div>
				{isWorking && (
					<div className="row-actions">
						<button
							type="button"
							className="btn"
							onClick={() => ctx.send({ type: 'action', action: { type: 'interrupt', ref } })}
						>
							Stop
						</button>
					</div>
				)}
			</div>
			<div className="ss-main">
				<div className="chat" ref={streamRef}>
					{!session && (
						<p className="msg c-dim">
							Setup isn't running on {ctx.machineTitle} yet. Ask anything below and it starts: it
							reads your repos, records what it finds with crew commands, and asks you only what it
							can't know.
						</p>
					)}
					{session?.stream.length === 0 && (
						<p className="msg c-dim">
							Ask anything: add a project, fix a server, check this machine.
						</p>
					)}
					{session?.stream.map((item) => {
						const line = recorded.find((entry) => entry.afterId === item.id);

						return (
							<div key={item.id} className="chat-item">
								<StreamLine item={item} />
								{line && <div className="rec-line">✓ recorded · {line.text}</div>}
							</div>
						);
					})}
					{draftText && (
						<div className="line text">
							<Markdown text={draftText} />
							<span className="caret" />
						</div>
					)}
					{asks.map((ask) => (
						<AnswerCard
							key={ask.id}
							ask={ask}
							ctx={ctx}
							onOwnWords={(askId) => {
								setAnswering(askId);
								fieldRef.current?.focus();
							}}
						/>
					))}
				</div>
				<form className="reply" onSubmit={submit}>
					<input
						ref={fieldRef}
						type="text"
						placeholder={
							answeringAsk ? 'Your answer, in your own words…' : 'Reply to Claude, or ask anything…'
						}
						aria-label="Reply to setup"
						autoComplete="off"
						value={text}
						onChange={(event) => setText(event.target.value)}
					/>
					<button type="submit" className="btn primary">
						{answeringAsk ? 'Answer' : isWorking ? 'Queue' : 'Send'}
					</button>
				</form>
			</div>
		</section>
	);
};

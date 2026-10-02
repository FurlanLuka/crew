import type {
	Input,
	Session,
	Stamped,
	State,
	Subagent,
	SubagentItem,
	SubagentItemContent,
	SubagentRun,
} from '../shared/protocol.js';
import type { ReducerResult } from './reducer.js';
import { updateSession, withoutEffects } from './helpers.js';

const SUBAGENT_INPUTS = [
	'subagent_started',
	'subagent_step',
	'subagent_item',
	'subagent_backgrounded',
	'subagent_ended',
] as const;

type SubagentInput = Extract<Input, { type: (typeof SUBAGENT_INPUTS)[number] }>;

const SUBAGENT_INPUT_SET = new Set<string>(SUBAGENT_INPUTS);

export const isSubagentInput = (input: Input): input is SubagentInput =>
	SUBAGENT_INPUT_SET.has(input.type);

// A foreground sub-agent ends with the turn; a background one outlives it, so the work goes on.
export const hasBackgroundWork = (session: Pick<Session, 'subagents'>): boolean =>
	session.subagents.some((subagent) => subagent.isBackground);

const updateSubagent = (
	session: Session,
	taskId: string,
	patch: (subagent: Subagent) => Subagent,
): Session => ({
	...session,
	subagents: session.subagents.map((subagent) =>
		subagent.taskId === taskId ? patch(subagent) : subagent,
	),
});

// Every browser gets the whole state and replays every input: transcripts are capped to stay small.
export const SUBAGENT_RUNS_KEPT = 10;
export const SUBAGENT_ITEMS_KEPT = 200;
export const SUBAGENT_TEXT_CHARS = 2000;

const clipItem = (item: SubagentItemContent, id: string, at: number): SubagentItem => {
	if (item.kind !== 'text' || item.text.length <= SUBAGENT_TEXT_CHARS) {
		return { ...item, id, at } as SubagentItem;
	}

	return { ...item, id, at, text: `${item.text.slice(0, SUBAGENT_TEXT_CHARS)}…` };
};

// Newest kept; a sub-agent still running is never the one dropped.
const keepRecentRuns = (session: Session, runs: SubagentRun[], starting: string): SubagentRun[] => {
	const running = new Set([starting, ...session.subagents.map((subagent) => subagent.taskId)]);
	const kept = [...runs];

	while (kept.length > SUBAGENT_RUNS_KEPT) {
		const oldestEnded = kept.findIndex((run) => !running.has(run.taskId));

		if (oldestEnded === -1) {
			break;
		}

		kept.splice(oldestEnded, 1);
	}

	return kept;
};

const openRun = (
	session: Session,
	input: Extract<SubagentInput, { type: 'subagent_started' }>,
	at: number,
): Session =>
	// Seen again (a resumed task), its transcript goes on where it was.
	session.subagentRuns.some((run) => run.taskId === input.taskId)
		? session
		: {
				...session,
				subagentRuns: keepRecentRuns(
					session,
					[
						...session.subagentRuns,
						{
							taskId: input.taskId,
							toolUseId: input.toolUseId ?? null,
							agentType: input.agentType,
							description: input.description,
							startedAt: at,
							items: [],
						},
					],
					input.taskId,
				),
			};

export const reduceSubagent = (
	state: State,
	input: SubagentInput,
	stamped: Pick<Stamped, 'id' | 'at'>,
): ReducerResult => {
	const { at } = stamped;

	switch (input.type) {
		case 'subagent_started':
			return withoutEffects(
				updateSession(state, input.ref, (current) => {
					const session = openRun(current, input, at);

					// Seen twice (a resumed task), it keeps the time it first started.
					if (session.subagents.some((subagent) => subagent.taskId === input.taskId)) {
						return session;
					}

					return {
						...session,
						subagents: [
							...session.subagents,
							{
								taskId: input.taskId,
								agentType: input.agentType,
								description: input.description,
								startedAt: at,
								step: null,
								isBackground: input.isBackground,
							},
						],
					};
				}),
			);

		case 'subagent_step':
			return withoutEffects(
				updateSession(state, input.ref, (session) =>
					updateSubagent(session, input.taskId, (subagent) => ({ ...subagent, step: input.step })),
				),
			);

		case 'subagent_item':
			return withoutEffects(
				updateSession(state, input.ref, (session) => ({
					...session,
					subagentRuns: session.subagentRuns.map((run) =>
						run.taskId === input.taskId
							? {
									...run,
									items: [...run.items, clipItem(input.item, stamped.id, at)].slice(
										-SUBAGENT_ITEMS_KEPT,
									),
								}
							: run,
					),
				})),
			);

		case 'subagent_backgrounded':
			return withoutEffects(
				updateSession(state, input.ref, (session) =>
					updateSubagent(session, input.taskId, (subagent) => ({
						...subagent,
						isBackground: true,
					})),
				),
			);

		// The running row goes; its transcript stays in subagentRuns.
		case 'subagent_ended':
			return withoutEffects(
				updateSession(state, input.ref, (session) => ({
					...session,
					subagents: session.subagents.filter((subagent) => subagent.taskId !== input.taskId),
				})),
			);
	}
};

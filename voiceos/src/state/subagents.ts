import type { Input, Session, State, Subagent } from '../shared/protocol.js';
import type { ReducerResult } from './reducer.js';
import { updateSession, withoutEffects } from './helpers.js';

const SUBAGENT_INPUTS = [
	'subagent_started',
	'subagent_step',
	'subagent_backgrounded',
	'subagent_ended',
] as const;

type SubagentInput = Extract<Input, { type: (typeof SUBAGENT_INPUTS)[number] }>;

const SUBAGENT_INPUT_SET = new Set<string>(SUBAGENT_INPUTS);

export const isSubagentInput = (input: Input): input is SubagentInput =>
	SUBAGENT_INPUT_SET.has(input.type);

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

export const reduceSubagent = (state: State, input: SubagentInput, at: number): ReducerResult => {
	switch (input.type) {
		case 'subagent_started':
			return withoutEffects(
				updateSession(state, input.ref, (session) =>
					// Seen twice (a resumed task), it keeps the time it first started.
					session.subagents.some((subagent) => subagent.taskId === input.taskId)
						? session
						: {
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
							},
				),
			);

		case 'subagent_step':
			return withoutEffects(
				updateSession(state, input.ref, (session) =>
					updateSubagent(session, input.taskId, (subagent) => ({ ...subagent, step: input.step })),
				),
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

		case 'subagent_ended':
			return withoutEffects(
				updateSession(state, input.ref, (session) => ({
					...session,
					subagents: session.subagents.filter((subagent) => subagent.taskId !== input.taskId),
				})),
			);
	}
};

// The box's slash commands that act on a session instead of going to its Claude: the commands it
// lists for the "/" menu, a reload of its plugins or skills, and its model. Each reaches the worker
// as an effect (a remote session's through the link) and comes back as a line in the stream.
import type { Input, Stamped, State } from '../shared/protocol.js';
import { pushNotice, updateSession, withoutEffects } from './helpers.js';
import type { ReducerResult } from './reducer.js';

type SessionCommandInput = Extract<
	Input,
	{ type: 'commands_listed' | 'reload_session' | 'set_model' }
>;

// A worker is there to ask: started, and not yet stopped.
const hasWorker = (state: State, ref: string): boolean => {
	const status = state.sessions[ref]?.status;

	return status === 'idle' || status === 'running' || status === 'blocked';
};

export const reduceSessionCommand = (
	state: State,
	input: SessionCommandInput,
	stamped: Stamped,
): ReducerResult => {
	if (!state.sessions[input.ref]) {
		return withoutEffects(state);
	}

	switch (input.type) {
		case 'commands_listed':
			return withoutEffects(
				updateSession(state, input.ref, (session) => ({ ...session, commands: input.commands })),
			);
		case 'reload_session':
		case 'set_model': {
			if (!hasWorker(state, input.ref)) {
				return withoutEffects(
					pushNotice({
						state,
						ref: input.ref,
						text: 'Start the session first.',
						stamped,
						suffix: 'not-started',
					}),
				);
			}

			return {
				state,
				effects: [
					input.type === 'set_model'
						? { type: 'worker_set_model', ref: input.ref, model: input.model }
						: {
								type: 'worker_reload',
								ref: input.ref,
								kind: input.kind,
								...(input.force ? { force: true as const } : {}),
							},
				],
			};
		}
	}
};

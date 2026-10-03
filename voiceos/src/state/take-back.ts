import type { Input, State } from '../shared/protocol.js';
import type { ReducerResult } from './reducer.js';
import { updateSession, WITHDRAWN_KEPT, withoutEffects } from './helpers.js';
import { giveBack, joinAttachments } from './attachments.js';

type TakeBackInput = Extract<Input, { type: 'take_back' }>;

export const reduceTakeBack = (state: State, input: TakeBackInput): ReducerResult => {
	// Words the developer takes back before the session acts on them: a queued message is removed, a
	// side question withdrawn (its answer is never said or queued), a held switch dropped.
	const { ref, id } = input;
	// Files that went with those words wait again for the next ones.
	const heldRedirect = state.asks.find((ask) => ask.id === id && ask.kind === 'redirect');
	const carried = joinAttachments(
		state.sessions[ref]?.queue.find((message) => message.id === id)?.attachments,
		heldRedirect?.kind === 'redirect' ? heldRedirect.attachments : undefined,
	);
	const withoutAsk = giveBack(
		{
			...state,
			asks: state.asks.filter((ask) => !(ask.id === id && ask.kind === 'redirect')),
		},
		ref,
		carried,
	);

	return withoutEffects(
		updateSession(withoutAsk, ref, (session) => {
			const isAsking = session.stream.some(
				(item) => item.id === id && item.kind === 'aside' && item.status === 'asking',
			);

			return {
				...session,
				queue: session.queue.filter((message) => message.id !== id),
				stream: isAsking
					? session.stream.map((item) =>
							item.id === id && item.kind === 'aside'
								? { ...item, status: 'withdrawn' as const }
								: item,
						)
					: session.stream,
				withdrawnAsides: isAsking
					? [...session.withdrawnAsides, id].slice(-WITHDRAWN_KEPT)
					: session.withdrawnAsides,
			};
		}),
	);
};

// "How is crew research doing?" answered from Voice OS's read of another session: the developer may
// want to go there next, so "Switch to X?" follows the answer (debug note 35). Pure: the router acts.
import type { State } from '../shared/protocol.js';
import type { ToolCall } from '../tools/definitions.js';
import { readScreenRef } from '../state/helpers.js';
import { checkRef } from '../tools/results.js';
import { endsInQuestion } from '../shared/spoken.js';

interface ReadStatusOfferParams {
	state: State;
	calls: (Pick<ToolCall, 'name'> & Partial<Pick<ToolCall, 'input' | 'ok'>>)[];
	reply: string;
}

// The one session the answer was about, when it is worth offering; null otherwise. Only a turn that
// did nothing but read: a send, a switch or any command already moved the conversation on. A reply
// that asks something back keeps the developer's next "yes" for that question.
export const readStatusOffer = ({ state, calls, reply }: ReadStatusOfferParams): string | null => {
	if (
		!reply.trim() ||
		endsInQuestion(reply) ||
		calls.length === 0 ||
		calls.some((call) => call.name !== 'read_state' || !call.ok)
	) {
		return null;
	}

	// The kernel names a session as it heard it ("checkout api"): read the ref the tool resolved.
	const refs = new Set(
		calls.map((call) => {
			const checked = checkRef(state, call.input?.ref);

			return checked.ok ? checked.ref : null;
		}),
	);
	const [ref] = refs;

	// Every session at once ("what's everyone doing?"), or several: no one place to go.
	if (refs.size !== 1 || !ref) {
		return null;
	}

	return readScreenRef(state) !== ref ? ref : null;
};

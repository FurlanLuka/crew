import { type State, type PendingAsk, type Denial, isOfferFresh } from '../shared/protocol.js';
import { describeWork, formatAge } from '../state/working.js';
import { findOpenQuestion } from '../state/asks.js';

const RECENT_TOOL_STEPS = 3;
const LAST_REPLY_CHARS = 2000;

const findLastReply = (state: State, ref: string): string | null => {
	// Read back in full on "what did it say": the recent lines clip every message to a line.
	const lastText = state.sessions[ref]?.stream.findLast((item) => item.kind === 'text');

	if (lastText?.kind !== 'text') {
		return null;
	}

	return lastText.text.length > LAST_REPLY_CHARS
		? `${lastText.text.slice(0, LAST_REPLY_CHARS)}…`
		: lastText.text;
};

const listRecentLines = (state: State, ref: string, count: number): string[] => {
	const session = state.sessions[ref];

	if (!session) {
		return [];
	}

	const saidLines = session.stream
		.filter((item) => item.kind === 'text' || item.kind === 'user')
		.slice(-count)
		.map((item) =>
			item.kind === 'user'
				? `developer: ${item.text}`
				: item.kind === 'text'
					? `claude: ${item.text.slice(0, 300)}`
					: '',
		);

	if (session.status !== 'running' && session.status !== 'blocked') {
		return saidLines;
	}

	// While it works, its latest tool steps are the evidence for "how is it going?".
	const stepLines = session.stream
		.filter((item) => item.kind === 'tool')
		.slice(-RECENT_TOOL_STEPS)
		.map((item) =>
			item.kind === 'tool' ? `step: ${item.name} ${item.summary}`.slice(0, 200) : '',
		);

	return [...saidLines, ...stepLines];
};

const describePending = (ask: PendingAsk): Record<string, unknown> => {
	switch (ask.kind) {
		case 'permission':
			return { kind: 'permission', summary: ask.summary };
		case 'plan':
			return { kind: 'plan' };
		case 'command':
			// Voice OS asked "say yes to confirm": the developer's yes or no answers it.
			return { kind: 'confirm', command: `/${ask.command}` };
		case 'question': {
			// The one asked now: several questions are answered one at a time.
			const open = findOpenQuestion(ask);
			const left = ask.questions.length - (open?.index ?? ask.questions.length);

			return {
				kind: 'question',
				question: open?.question.question ?? '',
				options: open?.question.options.map((option) => option.label) ?? [],
				...(left > 1 ? { questions_left: left } : {}),
			};
		}
	}
};

export const findLatestDenial = (state: State, ref: string): Denial | undefined => {
	return state.denials.filter((denial) => denial.ref === ref).at(-1);
};

export interface DescribeSessionParams {
	state: State;
	ref: string;
	isDetailed: boolean;
	now: number;
}

export const describeSession = ({
	state,
	ref,
	isDetailed,
	now,
}: DescribeSessionParams): Record<string, unknown> => {
	const session = state.sessions[ref];

	if (!session) {
		return { ref, error: 'no such session' };
	}

	const ask = state.asks.find((pendingAsk) => pendingAsk.ref === ref);
	const denial = findLatestDenial(state, ref);
	// Only servers that are not running, so an all-healthy worktree adds nothing to every message.
	const troubledServers = (state.devServers[ref] ?? []).filter(
		(server) => server.state !== 'running',
	);
	const devOffer = state.devOffer?.ref === ref ? state.devOffer : null;
	const work = describeWork(session, now);
	const lastReply = isDetailed ? findLastReply(state, ref) : null;

	return {
		ref,
		status: session.status,
		topic: session.topic,
		...(work.requests.length > 0 ? { last_messages_to_it: work.requests } : {}),
		...(work.for ? { working_for: work.for } : {}),
		...(ask ? { pending: describePending(ask) } : {}),
		...(session.needsUser ? { asked: session.needsUser.text, asked_ago: work.waitingFor } : {}),
		...(denial ? { blocked: denial.summary } : {}),
		queued: session.queue.length,
		...(troubledServers.length > 0
			? {
					dev_servers: troubledServers.map((server) => ({
						name: server.name,
						state: server.state,
						detail: server.detail,
					})),
				}
			: {}),
		...(devOffer
			? {
					fix_offer: {
						servers: devOffer.servers,
						ago: formatAge(now - devOffer.at),
						...(isOfferFresh(devOffer, now) ? {} : { lapsed: true }),
					},
				}
			: {}),
		...(isDetailed ? { recent: listRecentLines(state, ref, 6) } : {}),
		...(lastReply ? { last_reply: lastReply } : {}),
	};
};

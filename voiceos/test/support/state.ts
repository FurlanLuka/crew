import type {
	PendingAsk,
	Session,
	SessionStatus,
	State,
	VoiceEntry,
} from '../../src/shared/protocol.js';
import { GRID } from '../../src/shared/protocol.js';
import { createInitialState, createSession } from '../../src/state/reducer.js';

export interface FixtureWork {
	ref: string;
	request: string;
	minutesAgo: number;
	// Done with what it was last asked.
	idle?: boolean;
	// What the session last said.
	said?: string;
}

export interface FixtureLogEntry {
	utterance: string;
	reply: string;
	did: string[];
	minutesAgo?: number;
}

export interface FixtureContext {
	view?: string;
	// Whose it is by default: permission on wrk1, question and plan on store-front/main.
	ask?: 'permission' | 'question' | 'plan';
	askOn?: string;
	// A second permission, on that ref.
	alsoAsk?: string;
	stopped?: string[];
	needs?: string;
	needsSecondsAgo?: number;
	// What the `needs` session asked, as Voice OS wrote it down.
	asked?: string;
	// A worktree whose api server died on start (its web server runs).
	dev?: string;
	// The last thing the `needs` session wrote, when a case depends on it (a question with options).
	said?: string;
	// Voice OS offered to fix `ref`'s servers.
	offer?: { ref: string; secondsAgo: number };
	// That session's last command was blocked.
	denied?: string;
	work?: FixtureWork[];
	// What was said earlier on the case's screen; times are relative to `now`.
	voiceLog?: FixtureLogEntry[];
	// The last thing Voice OS asked aloud.
	alert?: { text: string; secondsAgo: number; ref?: string };
}

export const FIXTURE_TOPICS: Record<string, string> = {
	voiceos: 'crew setup and housekeeping',
	'store-front/main': 'Locale placeholder cleanup',
	'store-front/wrk1': 'Search ranking measurement',
	'checkout-api/main': 'Checkout retry backoff',
};

export const FIXTURE_REFS = [
	'voiceos',
	'store-front/main',
	'store-front/wrk1',
	'checkout-api/main',
];

const createPermissionAsk = (id: string, ref: string, at: number): PendingAsk => ({
	id,
	ref,
	at,
	kind: 'permission',
	toolName: 'Bash',
	summary: 'run git push',
	input: { command: 'git push' },
	suggestions: [],
});

const listPendingAsks = (context: FixtureContext, at: number): PendingAsk[] => {
	const asks: PendingAsk[] = [];

	if (context.ask === 'permission') {
		asks.push(createPermissionAsk('ask-1', context.askOn ?? 'store-front/wrk1', at));
	}

	if (context.ask === 'question') {
		asks.push({
			id: 'ask-1',
			ref: context.askOn ?? 'store-front/main',
			at,
			kind: 'question',
			input: {},
			questions: [
				{
					question: 'Where should events go?',
					multiSelect: false,
					options: [{ label: 'New table' }, { label: 'Reuse orders' }, { label: 'Defer' }],
				},
			],
		});
	}

	if (context.ask === 'plan') {
		asks.push({
			id: 'ask-1',
			ref: context.askOn ?? 'store-front/main',
			at,
			kind: 'plan',
			input: {},
			plan: 'Add an events table, backfill it, then switch reads over.',
		});
	}

	if (context.alsoAsk) {
		asks.push(createPermissionAsk('ask-2', context.alsoAsk, at));
	}

	return asks;
};

interface ResolveFixtureStatusParams {
	isStopped: boolean;
	isBlocked: boolean;
	work: FixtureWork | undefined;
}

const resolveFixtureStatus = ({
	isStopped,
	isBlocked,
	work,
}: ResolveFixtureStatusParams): SessionStatus => {
	if (isStopped) {
		return 'stopped';
	}

	if (isBlocked) {
		return 'blocked';
	}

	return work && !work.idle ? 'running' : 'idle';
};

interface CreateFixtureSessionParams {
	ref: string;
	context: FixtureContext;
	asks: PendingAsk[];
	now: number;
}

const createFixtureSession = ({ ref, context, asks, now }: CreateFixtureSessionParams): Session => {
	const work = context.work?.find((candidate) => candidate.ref === ref);
	const isWaitingOnUser = context.needs === ref;
	const said = isWaitingOnUser ? context.said : work?.said;
	// A pending ask holds its session's turn open (the reducer's ask_opened).
	const isBlocked = asks.some((ask) => ask.ref === ref);
	const status = resolveFixtureStatus({
		isStopped: context.stopped?.includes(ref) ?? false,
		isBlocked,
		work,
	});

	return {
		...createSession({
			ref,
			label: ref,
			branch: `crew/${ref}`,
			cwd: `/w/${ref}`,
			dirs: [],
			isPinned: ref === 'voiceos',
		}),
		status,
		topic: FIXTURE_TOPICS[ref] ?? null,
		needsUser: isWaitingOnUser
			? {
					text: context.asked
						? context.asked
						: context.said
							? 'asks: which approach should I take? Say options to hear them.'
							: 'checkout api, main asks: deploy the fix to staging?',
					at: now - (context.needsSecondsAgo ?? 60) * 1000,
				}
			: null,
		requests: work ? [{ text: work.request, at: now - work.minutesAgo * 60_000 }] : [],
		stream: said ? [{ id: 'said', at: now - 1000, kind: 'text' as const, text: said }] : [],
	};
};

export const createFixtureState = (context: FixtureContext = {}, now = Date.now()): State => {
	// Crew's generic example worktrees, all idle, plus whatever the context sets up.
	const asks = listPendingAsks(context, now - 30_000);
	const sessions = Object.fromEntries(
		FIXTURE_REFS.map((ref) => [ref, createFixtureSession({ ref, context, asks, now })]),
	);
	const voiceLog: VoiceEntry[] = (context.voiceLog ?? []).map((entry) => ({
		utterance: entry.utterance,
		reply: entry.reply,
		did: entry.did,
		at: now - (entry.minutesAgo ?? 1) * 60_000,
	}));

	return {
		...createInitialState(),
		sessions,
		order: FIXTURE_REFS,
		asks,
		denials: context.denied
			? [
					{
						id: 'denied-1',
						ref: context.denied,
						toolName: 'Bash',
						summary: 'rm -rf dist',
						at: now - 20_000,
					},
				]
			: [],
		devServers: context.dev
			? {
					[context.dev]: [
						{
							name: 'api',
							port: 4100,
							url: null,
							state: 'died',
							detail: 'Error: connect ECONNREFUSED 127.0.0.1:5432',
						},
						{ name: 'web', port: 4101, url: null, state: 'running', detail: null },
					],
				}
			: {},
		devOffer: context.offer
			? { ref: context.offer.ref, servers: ['api'], at: now - context.offer.secondsAgo * 1000 }
			: null,
		spoken: context.alert
			? [
					{
						id: 'alert',
						text: context.alert.text,
						source: 'alert',
						at: now - context.alert.secondsAgo * 1000,
						...(context.alert.ref ? { ref: context.alert.ref, isAsking: true as const } : {}),
					},
				]
			: [],
		voiceLog: voiceLog.length ? { [context.view ?? GRID]: voiceLog } : {},
		view: context.view ? { kind: 'session', ref: context.view } : { kind: 'grid' },
		focus: context.view ?? null,
	};
};

import type {
	PendingAsk,
	Session,
	SessionStatus,
	State,
	VoiceEntry,
} from '../../src/shared/protocol.js';
import { HOME_SCREEN, isSdkAsk } from '../../src/shared/protocol.js';
import { createInitialState, createSession } from '../../src/state/reducer.js';
import { isSetupRef, toLocalRef } from '../../src/shared/machine-ref.js';

export interface FixtureWork {
	ref: string;
	request: string;
	minutesAgo: number;
	// Done with what it was last asked.
	idle?: boolean;
	// What the session last said.
	said?: string;
	// Words waiting behind its current work.
	queued?: string[];
}

export interface FixtureLogEntry {
	utterance: string;
	reply: string;
	did: string[];
	minutesAgo?: number;
}

export interface FixtureContext {
	view?: string;
	// Whose it is by default: permission on wrk1, the others on store-front/main.
	// command: a /clear Voice OS holds until the developer says yes.
	ask?: 'permission' | 'question' | 'plan' | 'command' | 'redirect';
	// The open question's option labels, when a case depends on them.
	options?: string[];
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
	// A session that asked while the developer looked elsewhere: only "<ref> needs you: <about>" was
	// said; its question is held for when they switch there.
	announced?: { ref: string; question: string; about: string; secondsAgo: number };
	// What a session said while the developer looked elsewhere, held and not yet heard.
	update?: { ref: string; text: string };
	// Docs and artifacts sessions made, oldest first.
	docs?: { ref: string; url: string; title: string }[];
	// Lines sessions said shortly before the developer spoke, oldest first.
	heard?: {
		text: string;
		ref: string;
		secondsAgo: number;
		endedSecondsAgo?: number;
		cut?: boolean;
		// Voice OS's report of that session's update (the meanwhile line), not the session's own words.
		update?: boolean;
		// Said by Voice OS itself (its reply, its own question), not by a session.
		byVoiceOs?: boolean;
	}[];
	// More sessions on this Mac than the four generic ones (a real-speech case names its own).
	extraRefs?: string[];
	// Sessions that are not active; every other one is (what a fixture meant before the active set).
	inactive?: string[];
	// The developer's own names for sessions, by full ref.
	names?: Record<string, string>;
	// Another machine, connected, with sessions of its own (full refs: "personal:store-front/main").
	machine?: { id: string; name: string; refs: string[] };
	// Voice OS asked "Switch to <ref>?" that many seconds ago.
	// text: what Voice OS said to offer it ("Sent to checkout. Switch there?"), else "Switch to X?".
	// update: it was the meanwhile line about that session ("Meanwhile, … Switch there?").
	// kind: "…isn't active. Activate it?" or "…is working. Deactivate anyway?" instead of a switch.
	switchOffer?: {
		ref: string;
		secondsAgo: number;
		text?: string;
		update?: boolean;
		kind?: 'activate' | 'deactivate';
	};
	// Other sessions' updates waiting for the meanwhile line.
	meanwhile?: { ref: string; kind: 'done' | 'needs'; about: string }[];
}

// What each idle fixture session was last asked: the work the developer names it by ("the ranking
// work") when the context gives it none of its own.
export const FIXTURE_REQUESTS: Record<string, string> = {
	setup: 'Check the crew setup and clean up housekeeping.',
	'store-front/main': 'Clean up the locale placeholders.',
	'store-front/wrk1': 'Measure the new search ranking.',
	'checkout-api/main': 'Add retry backoff to checkout.',
};

export const FIXTURE_REFS = ['setup', 'store-front/main', 'store-front/wrk1', 'checkout-api/main'];

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
					options: (context.options ?? ['New table', 'Reuse orders', 'Defer']).map((label) => ({
						label,
					})),
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

	if (context.ask === 'command') {
		asks.push({
			id: 'ask-1',
			ref: context.askOn ?? 'store-front/main',
			at,
			kind: 'command',
			command: 'clear',
			text: '/clear',
		});
	}

	// redirect: Voice OS asked whether to stop the running work and switch to this.
	if (context.ask === 'redirect') {
		asks.push({
			id: 'ask-1',
			ref: context.askOn ?? 'store-front/main',
			at,
			kind: 'redirect',
			text: 'Fix the login bug first.',
			target: null,
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
	const announced = context.announced?.ref === ref ? context.announced : undefined;
	const isWaitingOnUser = context.needs === ref || announced !== undefined;
	const said = isWaitingOnUser ? context.said : work?.said;
	// A pending ask holds its session's turn open (the reducer's ask_opened).
	const isBlocked = asks.some((ask) => ask.ref === ref && isSdkAsk(ask));
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
			isPinned: isSetupRef(ref),
		}),
		status,
		heldLine:
			context.update?.ref === ref
				? {
						id: 'update',
						at: now - 10_000,
						missed: 0,
						isAnnounced: false,
						kind: 'line',
						text: context.update.text,
						isAsking: false,
					}
				: announced
					? {
							id: 'held',
							at: now - announced.secondsAgo * 1000,
							missed: 0,
							isAnnounced: true,
							kind: 'line',
							text: announced.question,
							isAsking: true,
						}
					: null,
		needsUser: isWaitingOnUser
			? {
					text: announced
						? announced.question
						: context.asked
							? context.asked
							: context.said
								? 'asks: which approach should I take? Say options to hear them.'
								: 'checkout api, main asks: deploy the fix to staging?',
					at: now - (announced?.secondsAgo ?? context.needsSecondsAgo ?? 60) * 1000,
				}
			: null,
		requests: work
			? [{ text: work.request, at: now - work.minutesAgo * 60_000 }]
			: FIXTURE_REQUESTS[ref]
				? [{ text: FIXTURE_REQUESTS[ref], at: now - 30 * 60_000 }]
				: [],
		stream: [
			...(said ? [{ id: 'said', at: now - 1000, kind: 'text' as const, text: said }] : []),
			// Docs this session made, oldest first (the newest is what "open the doc" opens).
			...(context.docs ?? [])
				.filter((doc) => doc.ref === ref)
				.map((doc, index) => ({
					id: `doc-${index}`,
					at: now - 5000 + index,
					kind: 'doc' as const,
					url: doc.url,
					title: doc.title,
				})),
		],
		queue: (work?.queued ?? []).map((text, index) => ({
			id: `queued-${index}`,
			text,
			at: now - 10_000,
		})),
	};
};

export const createFixtureState = (context: FixtureContext = {}, now = Date.now()): State => {
	// Crew's generic example worktrees, all idle, plus whatever the context sets up.
	const asks = listPendingAsks(context, now - 30_000);
	const order = [
		...FIXTURE_REFS,
		...(context.extraRefs ?? []).filter((ref) => !FIXTURE_REFS.includes(ref)),
		...(context.machine?.refs ?? []),
	];
	const sessions = Object.fromEntries(
		order.map((ref) => {
			const session = createFixtureSession({ ref, context, asks, now });

			// Another machine's session is labelled by its local ref, as the remote reports it.
			return [ref, { ...session, label: toLocalRef(ref) }];
		}),
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
		order,
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
		spoken: [
			...(context.heard ?? []).map((heard, index) => ({
				id: `heard-${index}`,
				text: heard.text,
				source: heard.byVoiceOs ? ('kernel' as const) : ('narrator' as const),
				at: now - heard.secondsAgo * 1000,
				ref: heard.ref,
				// Live, Voice OS marks its own offers and asks as asking; a fixture line says so by ending in "?".
				...(heard.byVoiceOs && /\?\s*$/.test(heard.text) ? { isAsking: true as const } : {}),
				...(heard.endedSecondsAgo === undefined
					? {}
					: { endedAt: now - heard.endedSecondsAgo * 1000 }),
				...(heard.cut ? { isCut: true as const } : {}),
				...(heard.update ? { isUpdate: true as const, refs: [heard.ref] } : {}),
			})),
			...(context.announced
				? [
						{
							id: 'announced',
							text: `${context.announced.ref} needs you: ${context.announced.about}.`,
							source: 'narrator' as const,
							at: now - context.announced.secondsAgo * 1000,
							ref: context.announced.ref,
							isUpdate: true as const,
						},
					]
				: []),
			...(context.switchOffer
				? [
						{
							id: 'offer',
							text: context.switchOffer.text ?? `Switch to ${context.switchOffer.ref}?`,
							source: context.switchOffer.update ? ('narrator' as const) : ('kernel' as const),
							at: now - context.switchOffer.secondsAgo * 1000,
							endedAt: now - context.switchOffer.secondsAgo * 1000 + 1500,
							ref: context.switchOffer.ref,
							isAsking: true as const,
							...(context.switchOffer.update
								? { isUpdate: true as const, refs: [context.switchOffer.ref] }
								: {}),
						},
					]
				: []),
			...(context.alert
				? [
						{
							id: 'alert',
							text: context.alert.text,
							source: 'alert' as const,
							at: now - context.alert.secondsAgo * 1000,
							...(context.alert.ref ? { ref: context.alert.ref, isAsking: true as const } : {}),
						},
					]
				: []),
		],
		voiceLog: voiceLog.length ? { [context.view ?? HOME_SCREEN]: voiceLog } : {},
		view: context.view ? { kind: 'session', ref: context.view } : { kind: 'active' },
		focus: context.view ?? null,
		active: order.filter((ref) => !isSetupRef(ref) && !context.inactive?.includes(ref)),
		...(context.names ? { names: context.names } : {}),
		...(context.meanwhile
			? { meanwhile: context.meanwhile.map((item) => ({ ...item, at: now - 20_000 })) }
			: {}),
		...(context.switchOffer
			? {
					switchOffer: {
						ref: context.switchOffer.ref,
						at: now - context.switchOffer.secondsAgo * 1000,
						heardAt: now - context.switchOffer.secondsAgo * 1000 + 1500,
						...(context.switchOffer.kind ? { kind: context.switchOffer.kind } : {}),
					},
				}
			: {}),
		...(context.machine
			? {
					machines: {
						[context.machine.id]: {
							id: context.machine.id,
							host: `dev@${context.machine.id}`,
							name: context.machine.name,
							status: 'connected' as const,
							detail: null,
							since: 0,
						},
					},
				}
			: {}),
	};
};

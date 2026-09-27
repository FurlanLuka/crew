import type { Store } from '../state/store.js';
import type { Effect } from '../state/reducer.js';
import type { SpeechPriority } from '../speech/queue.js';
import { appendJournalEntry, describeTurnOutcome } from '../memory/journal.js';
import type { NarrateFunction } from './narrator.js';
import type { WriteTopic } from './topic.js';
import type { Narration } from './prompt.js';
import { cleanSpokenText } from '../shared/spoken.js';
import { readSpokenTag, stripSpokenTag, type SpokenTag } from '../shared/spoken-tags.js';
import type { Session } from '../shared/protocol.js';
import { describeAnnouncement, isOnScreen, isShortLine } from '../state/held-lines.js';
import { createLogger } from '../log.js';

const log = createLogger('narrator');

interface NarratedLine {
	text: string;
	priority: SpeechPriority;
	ref: string;
	isNamed: boolean;
	isAsking: boolean;
	isOwed?: boolean;
	chime?: 'needs';
	isHoldable?: boolean;
}

const OWED_FALLBACK_WORDS = 30;

const readFirstSentence = (text: string): string =>
	cleanSpokenText(text.trim().split(/(?<=[.!?])\s+/)[0] ?? '', OWED_FALLBACK_WORDS);

interface SettleOwedReportParams {
	narration: Narration;
	isOwed: boolean;
	sessionText: string;
}

export const settleOwedReport = ({
	narration,
	isOwed,
	sessionText,
}: SettleOwedReportParams): Narration => {
	// An instruction was passed on: the developer is waiting to hear how it
	// went, even when the narrator found it too small to mention or its call failed.
	if (!isOwed) {
		return narration;
	}

	const promised = { ...narration, speak: true, priority: 'high' as const };

	return narration.text.trim()
		? promised
		: { ...promised, text: readFirstSentence(sessionText) || 'It finished.' };
};

export const narrateFromTag = (spoken: SpokenTag, session: Session): Narration => ({
	// The session said it itself: no summary, and the topic stays what it was.
	speak: true,
	needs_user: spoken.isAsking,
	// Its own line answers what the developer asked: said like a reply, through "quiet" too.
	priority: 'high',
	text: cleanSpokenText(spoken.text),
	topic: session.topic,
});

export interface TurnNarratorOptions {
	store: Store;
	narrate: NarrateFunction;
	// Names the work after a turn the session spoke for itself (the narrator names it otherwise).
	writeTopic: WriteTopic;
	say: (line: NarratedLine) => void;
	journalDir: string;
	readGitHead: (cwd: string) => Promise<string | null>;
	now?: () => Date;
}

type NarrateEffect = Extract<Effect, { type: 'narrate' }>;
type NarrateAsideEffect = Extract<Effect, { type: 'narrate_aside' }>;

const ASIDE_FALLBACK_WORDS = 40;

export type AsideNarratorOptions = Pick<TurnNarratorOptions, 'store' | 'narrate' | 'say'>;

export const createAsideNarrator = ({ store, narrate, say }: AsideNarratorOptions) => {
	// Said like any answer to a direct question, but it is no turn: no topic, no needs-you, no journal.
	return async ({ ref, question, answer }: NarrateAsideEffect): Promise<void> => {
		const session = store.state.sessions[ref];

		if (!session) {
			return;
		}

		// The fork answers with the session's own spoken line: said as it is, no summary.
		const tag = readSpokenTag(answer);
		const body = stripSpokenTag(answer);
		const view = store.state.view;
		const text = tag
			? cleanSpokenText(tag.text)
			: (
					await narrate({
						label: session.label,
						text: body,
						asked: question,
						focused: view.kind === 'session' && view.ref === ref,
						topic: session.topic,
					})
				).text.trim() || cleanSpokenText(body, ASIDE_FALLBACK_WORDS);

		say({
			text,
			priority: 'high',
			ref,
			isNamed: true,
			isAsking: false,
		});
	};
};

interface SpeakOutcomeParams {
	options: TurnNarratorOptions;
	effect: NarrateEffect;
	narration: Narration;
	// What a question is about, for its announcement: waited for only if it is announced.
	readAbout: () => Promise<string | null>;
	// Rechecked after that wait: a newer turn ends it.
	isNewerTurn: () => boolean;
}

const speakOutcome = async ({
	options,
	effect,
	narration,
	readAbout,
	isNewerTurn,
}: SpeakOutcomeParams): Promise<void> => {
	// Said where the developer is looking; from elsewhere only when short, else announced and held
	// for when they switch there. Decided now, after the narrator's wait: the view may have changed.
	const { store } = options;
	const session = store.state.sessions[effect.ref];

	if (!session || !narration.speak || effect.isSpokenAlready) {
		return;
	}

	const text = narration.text;
	const held = session.heldLine;
	const isShown = isOnScreen(store.state, effect.ref);

	if (isShown || isShortLine(text)) {
		if (held) {
			store.dispatch({ type: 'held_line_heard', ref: effect.ref, id: held.id });
		}

		options.say({
			text,
			isHoldable: isShown,
			priority: effect.isOwed ? 'high' : narration.priority,
			ref: effect.ref,
			isNamed: true,
			isAsking: narration.needs_user,
			...(effect.isOwed ? { isOwed: true } : {}),
		});

		return;
	}

	// A tagged line was held as it streamed; a narrator's line is held here.
	if (!effect.isHeld) {
		store.dispatch({
			type: 'line_held',
			ref: effect.ref,
			text,
			isAsking: narration.needs_user,
		});
	}

	const kind = narration.needs_user ? 'needs' : 'done';
	const about = kind === 'needs' ? await readAbout() : null;

	// Switching there meanwhile replayed the line (and cleared it): nothing left to announce.
	if (isNewerTurn() || !store.state.sessions[effect.ref]?.heldLine) {
		return;
	}

	log.info('announced', { ref: effect.ref, kind });
	// Never asked aloud or owed: the developer has not heard the question, and a switch's replay
	// replaces this if it is still waiting to be said.
	options.say({
		text: describeAnnouncement({
			label: session.label,
			kind,
			about: about ?? (kind === 'needs' ? session.topic : null),
		}),
		priority: kind === 'needs' ? 'high' : 'normal',
		ref: effect.ref,
		isNamed: false,
		isAsking: false,
		...(kind === 'needs' ? { chime: 'needs' as const } : {}),
	});
};

export const createTurnNarrator = (options: TurnNarratorOptions) => {
	const now = options.now ?? (() => new Date());

	interface WriteTurnTopicParams {
		effect: NarrateEffect;
		spoken: SpokenTag;
		body: string;
	}

	const writeTurnTopic = async ({
		effect,
		spoken,
		body,
	}: WriteTurnTopicParams): Promise<string | null> => {
		// One call names the work and, for a question, what it is about; a pinned topic stays.
		const session = options.store.state.sessions[effect.ref];

		if (!session) {
			return null;
		}

		const { topic, about } = await options.writeTopic({
			ref: effect.ref,
			label: session.label,
			asked: effect.asked,
			spoken: spoken.text,
			body,
			topic: session.topic,
		});
		const current = options.store.state.sessions[effect.ref];

		if (topic && current && !current.isTopicPinned && topic !== current.topic) {
			options.store.dispatch({ type: 'topic_written', ref: effect.ref, topic });
		}

		return about;
	};

	return async (effect: NarrateEffect): Promise<void> => {
		const { store } = options;
		const session = store.state.sessions[effect.ref];

		if (!session) {
			return;
		}

		const view = store.state.view;
		const body = stripSpokenTag(effect.text);
		const narratedSendId = session.currentSendId;
		const heldIdBefore = session.heldLine?.id ?? null;
		const narration = effect.spoken
			? narrateFromTag(effect.spoken, session)
			: settleOwedReport({
					narration: await options.narrate({
						label: session.label,
						text: body,
						asked: effect.asked,
						focused: view.kind === 'session' && view.ref === effect.ref,
						topic: session.topic,
						isReportPromised: effect.isOwed,
					}),
					isOwed: effect.isOwed,
					sessionText: body,
				});
		// Off the speech path: only an announced question waits for what it is about. A pinned topic
		// needs the call only for that. A writer that throws keeps the topic it had.
		const needsAbout = effect.spoken?.isAsking === true;
		const topicCall =
			effect.spoken && (needsAbout || !session.isTopicPinned)
				? writeTurnTopic({ effect, spoken: effect.spoken, body }).catch((error: unknown) => {
						log.warn('topic not refreshed', { ref: effect.ref, error: String(error) });

						return null;
					})
				: Promise.resolve(null);
		// A newer turn started while the narrator thought: this report answers older words, so it is
		// neither said nor left as a question the session waits on.
		const isNewerTurn = () => store.state.sessions[effect.ref]?.currentSendId !== narratedSendId;
		const isStale = isNewerTurn();
		// The developer switched there meanwhile and heard the held line in the replay.
		const wasReplayed =
			heldIdBefore !== null && store.state.sessions[effect.ref]?.heldLine?.id !== heldIdBefore;

		if (isStale) {
			log.info('stale narration not said', { ref: effect.ref });
		} else {
			store.dispatch({
				type: 'narration',
				ref: effect.ref,
				needsUser: narration.needs_user,
				text: narration.text,
				topic: narration.topic,
			});
		}

		if (!isStale && !wasReplayed) {
			await speakOutcome({
				options,
				effect,
				narration,
				readAbout: () => (effect.spoken ? topicCall : Promise.resolve(narration.about ?? null)),
				isNewerTurn,
			});
		}

		appendJournalEntry(options.journalDir, {
			ts: now().toISOString(),
			ref: effect.ref,
			asked: effect.asked,
			did: describeTurnOutcome(narration.text, body),
			costUsd: store.state.sessions[effect.ref]?.costUsd ?? 0,
			head: await options.readGitHead(session.cwd),
		});
	};
};

export const readGitHead = async (cwd: string): Promise<string | null> => {
	try {
		const gitProcess = Bun.spawn(['git', '-C', cwd, 'rev-parse', '--short', 'HEAD'], {
			stdout: 'pipe',
			stderr: 'ignore',
		});
		const head = (await new Response(gitProcess.stdout).text()).trim();

		return (await gitProcess.exited) === 0 && head ? head : null;
	} catch {
		// No git or not a repository: the journal entry just has no HEAD.
		return null;
	}
};

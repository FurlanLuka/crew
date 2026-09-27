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
import { createLogger } from '../log.js';

const log = createLogger('narrator');

interface NarratedLine {
	text: string;
	priority: SpeechPriority;
	ref: string;
	isNamed: boolean;
	isAsking: boolean;
	isOwed?: boolean;
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

export const createTurnNarrator = (options: TurnNarratorOptions) => {
	const now = options.now ?? (() => new Date());

	interface RefreshTopicParams {
		effect: NarrateEffect;
		spoken: SpokenTag;
		body: string;
	}

	const refreshTopic = async ({ effect, spoken, body }: RefreshTopicParams): Promise<void> => {
		const session = options.store.state.sessions[effect.ref];

		if (!session || session.isTopicPinned) {
			return;
		}

		const topic = await options.writeTopic({
			label: session.label,
			asked: effect.asked,
			spoken: spoken.text,
			body,
			topic: session.topic,
		});

		if (topic && topic !== options.store.state.sessions[effect.ref]?.topic) {
			options.store.dispatch({ type: 'topic_written', ref: effect.ref, topic });
		}
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

		store.dispatch({
			type: 'narration',
			ref: effect.ref,
			needsUser: narration.needs_user,
			text: narration.text,
			topic: narration.topic,
		});

		// The developer spoke to it again while the narrator thought: this report answers older words.
		const isStale = store.state.sessions[effect.ref]?.currentSendId !== narratedSendId;

		if (isStale) {
			log.info('stale narration not said', { ref: effect.ref });
		}

		// A line the session wrote was said as soon as it streamed in.
		if (narration.speak && !effect.isSpokenAlready && !isStale) {
			options.say({
				text: narration.text,
				priority: effect.isOwed ? 'high' : narration.priority,
				ref: effect.ref,
				isNamed: true,
				isAsking: narration.needs_user,
				...(effect.isOwed ? { isOwed: true } : {}),
			});
		}

		if (effect.spoken) {
			void refreshTopic({ effect, spoken: effect.spoken, body });
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

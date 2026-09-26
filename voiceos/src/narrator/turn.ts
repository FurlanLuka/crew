import type { Store } from '../state/store.js';
import type { Effect } from '../state/reducer.js';
import type { SpeechPriority } from '../speech/queue.js';
import { appendJournalEntry, describeTurnOutcome } from '../memory/journal.js';
import type { NarrateFunction } from './narrator.js';
import { cleanSpokenText, type Narration } from './prompt.js';
import { joinTasks, sharesContentWords, upperFirst, type ReportOwed } from '../shared/ack.js';

interface NarratedLine {
	text: string;
	priority: SpeechPriority;
	ref: string;
	isNamed: boolean;
	isAsking: boolean;
	isOwed?: boolean;
}

const OWED_FALLBACK_WORDS = 30;
export const ACK_FRESH_MS = 10_000;

const readFirstSentence = (text: string): string =>
	cleanSpokenText(text.trim().split(/(?<=[.!?])\s+/)[0] ?? '', OWED_FALLBACK_WORDS);

interface SettleOwedReportParams {
	narration: Narration;
	owed: ReportOwed | null;
	sessionText: string;
	// The developer just heard the ack with the session on screen: the task need not be named again.
	isAckFresh?: boolean;
}

export const settleOwedReport = ({
	narration,
	owed,
	sessionText,
	isAckFresh = false,
}: SettleOwedReportParams): Narration => {
	// Voice OS said "Checking the logs": the developer is waiting to hear how it went, even when
	// the narrator found it too small to mention or its call failed.
	if (!owed) {
		return narration;
	}

	const tasks = upperFirst(joinTasks(owed.tasks));
	const written = narration.text.trim();
	const promised = { ...narration, speak: true, priority: 'high' as const };

	if (!written) {
		const outcome = readFirstSentence(sessionText);
		const text = tasks
			? outcome
				? `${tasks}: ${outcome}`
				: `${tasks} finished.`
			: outcome || 'It finished.';

		return { ...promised, text };
	}

	// A question is the report as it is; a report that does not say what it is about gets the task.
	const namesTask = owed.tasks.every((task) => sharesContentWords(written, task));

	return narration.needs_user || !tasks || namesTask || isAckFresh
		? promised
		: { ...promised, text: `${tasks}: ${written}` };
};

export interface TurnNarratorOptions {
	store: Store;
	narrate: NarrateFunction;
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

		const view = store.state.view;
		const narration = await narrate({
			label: session.label,
			text: answer,
			asked: question,
			focused: view.kind === 'session' && view.ref === ref,
			topic: session.topic,
		});

		say({
			text: narration.text.trim() || cleanSpokenText(answer, ASIDE_FALLBACK_WORDS),
			priority: 'high',
			ref,
			isNamed: true,
			isAsking: false,
		});
	};
};

export const createTurnNarrator = (options: TurnNarratorOptions) => {
	const now = options.now ?? (() => new Date());

	return async (effect: NarrateEffect): Promise<void> => {
		const { store } = options;
		const session = store.state.sessions[effect.ref];

		if (!session) {
			return;
		}

		const view = store.state.view;
		const isFocused = view.kind === 'session' && view.ref === effect.ref;
		const ackedAt = effect.owed?.ackedAt;
		const narration = settleOwedReport({
			narration: await options.narrate({
				label: session.label,
				text: effect.text,
				asked: effect.asked,
				focused: isFocused,
				topic: session.topic,
				promised: effect.owed?.tasks ?? null,
			}),
			owed: effect.owed,
			sessionText: effect.text,
			isAckFresh: isFocused && ackedAt !== undefined && now().getTime() - ackedAt <= ACK_FRESH_MS,
		});

		store.dispatch({
			type: 'narration',
			ref: effect.ref,
			needsUser: narration.needs_user,
			text: narration.text,
			topic: narration.topic,
		});

		if (narration.speak) {
			options.say({
				text: narration.text,
				priority: narration.priority,
				ref: effect.ref,
				isNamed: true,
				isAsking: narration.needs_user,
				...(effect.owed ? { isOwed: true } : {}),
			});
		}

		appendJournalEntry(options.journalDir, {
			ts: now().toISOString(),
			ref: effect.ref,
			asked: effect.asked,
			did: describeTurnOutcome(narration.text, effect.text),
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

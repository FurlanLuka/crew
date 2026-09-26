import type { Store } from '../state/store.js';
import type { Effect } from '../state/reducer.js';
import type { SpeechPriority } from '../speech/queue.js';
import { appendJournalEntry, describeTurnOutcome } from '../memory/journal.js';
import type { NarrateFunction } from './narrator.js';

interface NarratedLine {
	text: string;
	priority: SpeechPriority;
	ref: string;
	isNamed: boolean;
	isAsking: boolean;
}

export interface TurnNarratorOptions {
	store: Store;
	narrate: NarrateFunction;
	say: (line: NarratedLine) => void;
	journalDir: string;
	readGitHead: (cwd: string) => Promise<string | null>;
	now?: () => Date;
}

type NarrateEffect = Extract<Effect, { type: 'narrate' }>;

export const createTurnNarrator = (options: TurnNarratorOptions) => {
	const now = options.now ?? (() => new Date());

	return async (effect: NarrateEffect): Promise<void> => {
		const { store } = options;
		const session = store.state.sessions[effect.ref];

		if (!session) {
			return;
		}

		const view = store.state.view;
		const narration = await options.narrate({
			label: session.label,
			text: effect.text,
			asked: effect.asked,
			focused: view.kind === 'session' && view.ref === effect.ref,
			topic: session.topic,
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

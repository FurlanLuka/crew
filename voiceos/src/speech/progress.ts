// "Still on it, editing the router now.": while the session on screen works for minutes, now and then
// a short line says it is still going. Responsive, not talkative: only for the screen's own turn, only
// when its step changed, never over anything else, and further apart the longer it runs.
import { createLogger } from '../log.js';
import { isActive } from '../shared/active.js';
import { isSwitchOfferFresh, type Session, type State } from '../shared/protocol.js';
import { describeSummaryAloud, describeToolAloud } from '../shared/tool-aloud.js';
import { readScreenRef } from '../state/helpers.js';
import type { Store } from '../state/store.js';
import { composeProgressFallback, type ProgressInput } from '../voice-lines/prompt.js';
import { decideMeanwhile } from './meanwhile.js';
import type { SpeechMoment, VoiceOut } from './voice-out.js';

const log = createLogger('progress');

export type WriteProgress = (input: ProgressInput) => Promise<string>;

// The wait before each line, the last repeating: half a minute in, then 30 s, 60 s, every 2 min.
export const PROGRESS_GAPS_MS = [30_000, 30_000, 60_000, 120_000] as const;
// The session spoke for itself lately: it needs no one speaking for it.
export const OWN_LINE_QUIET_MS = 25_000;
export const PROGRESS_TICK_MS = 5_000;

export interface ProgressTurn {
	ref: string;
	startedAt: number;
	said: number;
	lastAt: number | null;
	// What the last line was about (its step and sub-agents); empty before the first.
	lastKey: string;
	lastLine: string | null;
	isWriting: boolean;
}

export const createProgressTurn = (ref: string, startedAt: number): ProgressTurn => ({
	ref,
	startedAt,
	said: 0,
	lastAt: null,
	lastKey: '',
	lastLine: null,
	isWriting: false,
});

// Their spoken form says what they do without the raw command or path; any other tool is said by its
// kind alone ("search the code"), since its summary carries the pattern or URL as typed.
const SUMMARY_TOOLS = new Set(['Bash', 'Read', 'Edit', 'MultiEdit', 'Write']);

// What the session does now, the short way, from this turn only.
export const readStep = (session: Session, since: number): string | null => {
	const tool = session.stream.findLast((item) => item.kind === 'tool' && item.at >= since);

	if (tool?.kind !== 'tool') {
		return null;
	}

	return SUMMARY_TOOLS.has(tool.name)
		? withoutExtensions(describeSummaryAloud(tool.name, tool.summary))
		: describeToolAloud(tool.name, {});
};

// "edit retry.ts" is read aloud as "retry dot ts": the file's name is enough to say what it is on.
export const withoutExtensions = (step: string): string =>
	step.replace(/\b([\w-]+)(?:\.[a-z][a-z0-9]*)+\b/gi, '$1');

const readGap = (said: number): number =>
	PROGRESS_GAPS_MS[Math.min(said, PROGRESS_GAPS_MS.length - 1)] ?? PROGRESS_GAPS_MS[0];

interface DecideProgressParams {
	turn: ProgressTurn;
	state: State;
	now: number;
	speech: SpeechMoment;
	isRouting: boolean;
}

export type ProgressDecision =
	| { kind: 'wait' }
	| { kind: 'skip'; reason: string }
	| { kind: 'say'; step: string | null; agents: string[]; key: string };

// Every reason to stay quiet is checked before the model is asked: a line nobody should hear costs
// nothing.
export const decideProgress = ({
	turn,
	state,
	now,
	speech,
	isRouting,
}: DecideProgressParams): ProgressDecision => {
	if (turn.isWriting || now < (turn.lastAt ?? turn.startedAt) + readGap(turn.said)) {
		return { kind: 'wait' };
	}

	const session = state.sessions[turn.ref];
	const blocker = ((): string | null => {
		if (!session || readScreenRef(state) !== turn.ref) {
			return 'off screen';
		}

		if (!isActive(state, turn.ref)) {
			return 'inactive';
		}

		if (session.status !== 'running') {
			return 'not running';
		}

		if (!speech.hasPage) {
			return 'no page';
		}

		if (speech.isMuted) {
			return 'muted';
		}

		if (speech.isTalking) {
			return 'talking';
		}

		if (isRouting) {
			return 'routing';
		}

		if (speech.isBusy) {
			return 'busy';
		}

		const hasOwnLine = state.spoken.some(
			(line) =>
				line.ref === turn.ref &&
				line.source === 'narrator' &&
				!line.isFiller &&
				now - line.at < OWN_LINE_QUIET_MS,
		);

		if (hasOwnLine) {
			return 'own line';
		}

		if (state.asks.length > 0 || isSwitchOfferFresh(state.switchOffer, now) || state.targetAsk) {
			return 'question open';
		}

		const meanwhile = decideMeanwhile({
			items: state.meanwhile,
			now,
			quietSince: speech.quietSince,
			isListening: speech.isListening,
		});

		return meanwhile.kind === 'now' ? 'meanwhile' : null;
	})();

	if (blocker || !session) {
		return { kind: 'skip', reason: blocker ?? 'off screen' };
	}

	const step = readStep(session, turn.startedAt);
	const agents = session.subagents.map((agent) => agent.description.trim()).filter(Boolean);
	const key = `${step ?? ''}|${session.subagents
		.map((agent) => agent.taskId)
		.sort()
		.join(',')}`;

	if ((!step && agents.length === 0) || key === turn.lastKey) {
		return { kind: 'skip', reason: 'nothing changed' };
	}

	return { kind: 'say', step, agents, key };
};

interface StartProgressParams {
	store: Store;
	voiceOut: Pick<VoiceOut, 'say' | 'readSpeech'>;
	writeProgress: WriteProgress;
	setTimer: (run: () => void, ms: number) => unknown;
	isRouting: () => boolean;
	now: () => number;
}

export const startProgress = ({
	store,
	voiceOut,
	writeProgress,
	setTimer,
	isRouting,
	now,
}: StartProgressParams): void => {
	let turn: ProgressTurn | null = null;
	let before = store.state;
	// Logged once per reason in a row: a tick every few seconds would fill the log with the same line.
	let lastSkip: string | null = null;

	const decide = (current: ProgressTurn): ProgressDecision =>
		decideProgress({
			turn: current,
			state: store.state,
			now: now(),
			speech: voiceOut.readSpeech(),
			isRouting: isRouting(),
		});

	const skip = (current: ProgressTurn, reason: string): void => {
		if (reason !== lastSkip) {
			lastSkip = reason;
			log.info('progress skipped', { ref: current.ref, reason });
		}
	};

	const check = async (current: ProgressTurn): Promise<void> => {
		const decision = decide(current);

		if (decision.kind !== 'say') {
			if (decision.kind === 'skip') {
				skip(current, decision.reason);
			}

			return;
		}

		const input = { step: decision.step, agents: decision.agents };
		current.isWriting = true;
		let line: string;

		try {
			line = await writeProgress({ ...input, lastProgress: current.lastLine });
		} catch {
			line = composeProgressFallback(input);
		}

		current.isWriting = false;

		// Asked again after the wait for the words: the moment may have passed meanwhile.
		const after =
			turn === current ? decide(current) : { kind: 'skip' as const, reason: 'turn over' };

		if (after.kind !== 'say') {
			skip(current, after.kind === 'skip' ? after.reason : 'not due');

			return;
		}

		current.said += 1;
		current.lastAt = now();
		current.lastKey = decision.key;
		current.lastLine = line;
		lastSkip = null;
		log.info('progress said', {
			ref: current.ref,
			step: decision.step,
			agents: decision.agents.length,
		});
		voiceOut.say({
			text: line,
			priority: 'low',
			source: 'kernel',
			ref: current.ref,
			isFiller: true,
		});
	};

	const tick = (current: ProgressTurn): void => {
		if (turn !== current) {
			return;
		}

		void check(current);
		setTimer(() => tick(current), PROGRESS_TICK_MS);
	};

	store.subscribe((_stamped, state) => {
		const was = before;
		before = state;
		const screen = readScreenRef(state);

		if (!screen || state.sessions[screen]?.status !== 'running') {
			turn = null;

			return;
		}

		if (turn?.ref === screen) {
			return;
		}

		turn = null;

		// Only a turn that starts while its session is on screen: one switched to midway is not timed.
		if (readScreenRef(was) !== screen || was.sessions[screen]?.status === 'running') {
			return;
		}

		const started = createProgressTurn(screen, now());
		turn = started;
		lastSkip = null;
		setTimer(() => tick(started), PROGRESS_TICK_MS);
	});
};

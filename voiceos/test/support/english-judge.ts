// The judge's answers as the English patterns Voice OS used before it had one: specs run the guards
// against a fixed, free, deterministic reading of English, and a spec that means another answer
// passes its own judge.
import type { Judge, JudgeAnswer, JudgeKey } from '../../src/judge/judge.js';

const CONSENT_PATTERN =
	/\b(?:yes|yeah|yep|yup|sure|ok|okay|alright|all right|fine|always|allow(?: it)?|approve[ds]?|go ahead|go for it|do it|let it|proceed|ship it|sounds good|absolutely|of course)\b/i;
const REFUSAL_PATTERN = /\b(?:no|nope|not|don't|do not|never|cancel|stop|wait)\b/i;
const BARE_REFUSAL_PATTERN = /^(?:no|nope|nah|deny|decline|don't|do not|cancel|reject)\b/i;
const BARE_TAKE_BACK_PATTERN =
	/^(?:(?:oh|no|sorry|actually|okay|ok|wait|um|uh)[,.!\s]+)*(?:take (?:that|it) back|cancel that|never ?mind|scratch that|forget (?:that|it)|ignore that)(?:[,\s]+please)?[.!\s]*$/i;
const MISROUTE_PATTERN =
	/\b(?:(?:that|this|it) (?:was|is) (?:meant )?for|I meant (?:that|this|it) for|(?:that|this|it) wasn'?t for|not (?:meant )?for (?:you|it|them))\b/i;
const TAKE_BACK_PATTERN =
	/\b(?:scratch that|never ?mind|forget that|ignore that|ignore(?=\s*[.!;:—-]))\b/i;
const MUTE_REQUEST_PATTERN =
	/^(?:(?:hey|okay|ok) )?(?:voice ?os )?(?:(?:okay|ok) )?(?:please )?(?:mute|be quiet|quiet|shut up|stop talking|shush|hush|silence|be silent|quiet please)(?: please)?(?: voice ?os)?(?: please)?$/;
const SAYS_WHAT_INSTEAD_PATTERN =
	/\b(?:stop|cancel|halt|drop)\b[^.?!]*\b(?:and|then)\s+(?!(?:wait|hold|pause|listen|look|think|let)\b)\w+/i;
const START_THEN_MORE_PATTERN =
	/\bstart\b[^.?!]*?(?:,?\s+(?:and\s+then|and|then)\s+(?:also\s+)?(?!(?:then\b|(?:open|show)\s+(?:it|them|that)\b))\w+|[.?!]\s+\S)/i;
const HANDS_FREE_PATTERN = /\bhands[\s-]?free\b|\b(?:start|stop) listening\b/i;
const ON_DEMAND_PATTERN =
	/\b(?:(?:switch|go|change|set|turn|put)(?: it| me)?(?: to| into| on)?|use) on[\s-]?demand\b|\bon[\s-]?demand (?:mode|listening)\b|\bwake[\s-]?word\b|\blisten(?:ing)? for (?:voice ?o ?s|my name|your name)\b/i;
const PUSH_PATTERN = /\bpush[\s-]to[\s-]talk\b/i;
const CHOOSE_HANDS_FREE_PATTERN =
	/\b(?:(?:switch|change|set|put)(?: it| me)?(?: to| into)|go|use|back to)\s+hands[\s-]?free\b/i;
const ON_PATTERN = /\b(?:on|start|enable|resume)\b/i;
const OFF_PATTERN = /\b(?:off|stop|disable|pause)\b/i;
const QUESTION_LEAD_PATTERN =
	/^(?:what|what's|whats|why|how|which|who|when|where|does|do|is|are|can|could|should|would|will)\b/;
const DEBUG_NOTE_REQUEST_PATTERN =
	/^\s*(?:(?:okay|ok|so|hey|and|please)[,\s]+)*(?:(?:can|could|would) you\s+)?(?:add|take|make)\s+(?:a\s+|another\s+)?debug\s*notes?\b/i;
const SETUP_ADDRESS_PATTERN =
	/^\s*(?:(?:hey|okay|ok|so)[,\s]+)?(?:voice\s*os|voiceos|setup)\b\s*[,:]/i;
const SETUP_WORK_PATTERN =
	/\b(?:worktrees?|workspaces?|projects?|bindings?|crew (?:fix|verify|check)|register)\b/i;
const MY_NOTES_PATTERN = /\bmy (?:own )?notes\b/i;
const BACK_REFERENCE_PATTERN = /\b(?:this|that|it|the last one|the note|what (?:you|i) just)\b/i;
const THIS_SESSION_PATTERN = /\b(?:this|the current) (?:session|one|claude)\b/i;
const BARE_NO_PATTERN = /^(?:no|nope|nah|not that one|here|stay|keep it here)\b/i;
const ASIDE_PATTERN = /\b(?:by the way|btw)\b/i;
const QUEUE_PATTERN = /\bqueue it\b/i;
const NOW_PATTERN =
	/\b(?:send|ask|tell)\s+(?:it|them|claude|this|that)\b(?:(?:\s+(?!(?:that|why|what|how|whether|if|when|where|which|who)\b)\w+){0,3}?\s+(?:right now|directly|immediately)|\s+now)\b/i;

const bare = (text: string): string =>
	text
		.trim()
		.replace(/\s+/g, ' ')
		.toLowerCase()
		.replace(/[.!?,]+/g, '');

const isPlainConsent = (text: string): boolean =>
	CONSENT_PATTERN.test(text) && !REFUSAL_PATTERN.test(text);

const readListenMode = (said: string): JudgeAnswer<'listen_mode'> => {
	if (ON_DEMAND_PATTERN.test(said)) {
		return OFF_PATTERN.test(said) ? 'push' : 'on-demand';
	}

	if (PUSH_PATTERN.test(said)) {
		return 'push';
	}

	if (CHOOSE_HANDS_FREE_PATTERN.test(said)) {
		return 'hands-free';
	}

	if (!HANDS_FREE_PATTERN.test(said)) {
		return 'unclear';
	}

	const isOn = ON_PATTERN.test(said);
	const isOff = OFF_PATTERN.test(said);

	return isOn === isOff ? 'unclear' : isOn ? 'hands-free' : 'off';
};

const isSendNow = (said: string): boolean => {
	const phrase = NOW_PATTERN.exec(said);

	return (
		phrase !== null && (said.replace(phrase[0], ' ').match(/[\p{L}\p{N}']+/gu) ?? []).length >= 2
	);
};

const yesIf = (isYes: boolean): 'yes' | 'no' => (isYes ? 'yes' : 'no');

const readEnglish = (key: JudgeKey, said: string): string => {
	switch (key) {
		case 'approves':
			return yesIf(CONSENT_PATTERN.test(said));
		case 'approves_plainly':
			return yesIf(isPlainConsent(said));
		case 'bare_answer':
			return yesIf(isPlainConsent(bare(said)) || BARE_REFUSAL_PATTERN.test(bare(said)));
		case 'refuses':
			return yesIf(BARE_REFUSAL_PATTERN.test(bare(said)));
		case 'take_back':
			return yesIf(BARE_TAKE_BACK_PATTERN.test(said.trim()));
		case 'misrouted':
			return yesIf(MISROUTE_PATTERN.test(said));
		case 'take_back_before':
			return yesIf(TAKE_BACK_PATTERN.test(said));
		case 'mute_only':
			return yesIf(
				MUTE_REQUEST_PATTERN.test(
					said
						.toLowerCase()
						.replace(/[,.!?;:]+/g, ' ')
						.replace(/\s+/g, ' ')
						.trim(),
				),
			);
		case 'says_instead':
			return yesIf(SAYS_WHAT_INSTEAD_PATTERN.test(said));
		case 'about_listening':
			return yesIf(
				HANDS_FREE_PATTERN.test(said) || ON_DEMAND_PATTERN.test(said) || PUSH_PATTERN.test(said),
			);
		case 'listen_mode':
			return readListenMode(said);
		case 'asks_about_options':
			return yesIf(QUESTION_LEAD_PATTERN.test(bare(said)));
		case 'debug_note':
			return yesIf(DEBUG_NOTE_REQUEST_PATTERN.test(said));
		case 'for_setup':
			return yesIf(SETUP_ADDRESS_PATTERN.test(said) || SETUP_WORK_PATTERN.test(said));
		case 'my_notes':
			return yesIf(MY_NOTES_PATTERN.test(said));
		case 'back_reference':
			return yesIf(BACK_REFERENCE_PATTERN.test(said));
		case 'this_session':
			return yesIf(THIS_SESSION_PATTERN.test(said));
		case 'more_than_start':
			return yesIf(START_THEN_MORE_PATTERN.test(said.trim()));
		case 'target_answer':
			return BARE_NO_PATTERN.test(bare(said))
				? 'no'
				: bare(said).split(' ').length <= 4 && isPlainConsent(bare(said))
					? 'yes'
					: 'other';
		case 'delivery':
			return ASIDE_PATTERN.test(said)
				? 'aside'
				: QUEUE_PATTERN.test(said)
					? 'queue'
					: isSendNow(said)
						? 'now'
						: 'default';
	}
};

export const englishJudge: Judge = async ({ key, utterance }) =>
	readEnglish(key, utterance) as JudgeAnswer<typeof key>;

// For a spec that means one answer whatever the words are.
export const judgeAlways =
	(answer: string): Judge =>
	async () =>
		answer as never;

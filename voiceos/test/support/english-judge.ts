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
const SETUP_ADDRESS_PATTERN =
	/^\s*(?:(?:hey|okay|ok|so)[,\s]+)?(?:voice\s*os|voiceos|setup)\b\s*[,:]/i;
const SETUP_WORK_PATTERN =
	/\b(?:worktrees?|workspaces?|projects?|bindings?|crew (?:fix|verify|check)|register)\b/i;
const THIS_SESSION_PATTERN = /\b(?:this|the current) (?:session|one|claude)\b/i;
const BARE_NO_PATTERN = /^(?:no|nope|nah|not that one|here|stay|keep it here)\b/i;

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

const yesIf = (isYes: boolean): 'yes' | 'no' => (isYes ? 'yes' : 'no');

// The words of the session's label a developer says for it: "checkout" for checkout-api/main. "main"
// names nothing: every workspace has one.
const readNameWords = (context = ''): string[] =>
	context
		.replace(/^The session:\s*/, '')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length >= 4 && word !== 'main');

// Addressed ("checkout, run the tests"), told or asked ("tell checkout to…"), sent something ("send
// this to checkout", "I meant that for checkout"): anything else only mentions it.
const isSpokenTo = (said: string, context?: string): boolean => {
	const names = readNameWords(context).join('|');

	if (!names) {
		return false;
	}

	const name = `(?:the\\s+)?(?:[\\w-]+\\s+)?(?:${names})\\b`;

	return [
		`^(?:(?:hey|okay|ok|so)[,\\s]+)?${name}(?:[\\s/-]+\\w+){0,2}\\s*[,:]`,
		`\\b(?:tell|ask|have|get|let)\\s+${name}`,
		`\\b(?:send|pass|forward)\\s+(?:this|that|it|these|them)\\b.*\\bto\\s+${name}`,
		`\\bmeant\\s+(?:this|that|it)\\s+for\\s+${name}`,
	].some((pattern) => new RegExp(pattern, 'i').test(said.trim()));
};

// Where the part named in the context starts: a take-back only counts before it.
const findPart = (said: string, context = ''): number => {
	const part = /"(.*)"$/.exec(context)?.[1] ?? '';
	const at = said.toLowerCase().indexOf(part.toLowerCase());

	return part && at >= 0 ? at : said.length;
};

const readEnglish = (key: JudgeKey, said: string, context?: string): string => {
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
			return yesIf(TAKE_BACK_PATTERN.test(said.slice(0, findPart(said, context))));
		case 'mute_only':
			return /^(?:stop|wait|halt|hold on)[.!]?$/i.test(said.trim())
				? 'stop'
				: yesIf(
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
		case 'option_reply':
			return QUESTION_LEAD_PATTERN.test(bare(said))
				? /\b(?:go|switch|open)\b.*\b(?:session|into|to)\b/i.test(said)
					? 'other'
					: 'question'
				: 'pick';
		case 'for_setup':
			return yesIf(SETUP_ADDRESS_PATTERN.test(said) || SETUP_WORK_PATTERN.test(said));
		case 'this_session':
			return yesIf(THIS_SESSION_PATTERN.test(said));
		case 'spoken_to':
			return yesIf(isSpokenTo(said, context));
		case 'more_than_start':
			return yesIf(START_THEN_MORE_PATTERN.test(said.trim()));
		case 'target_answer':
			return BARE_NO_PATTERN.test(bare(said))
				? 'no'
				: bare(said).split(' ').length <= 4 && isPlainConsent(bare(said))
					? 'yes'
					: 'other';
	}
};

export const englishJudge: Judge = async ({ key, utterance, context }) =>
	readEnglish(key, utterance, context) as JudgeAnswer<typeof key>;

// For a spec that means one answer whatever the words are.
export const judgeAlways =
	(answer: string): Judge =>
	async () =>
		answer as never;

// A fast path that decides alone: the spec fails if the judge is asked at all.
export const judgeNever: Judge = async ({ key }) => {
	throw new Error(`the judge was asked ${key}`);
};

// One answer per question, for guards that ask two ("not muted" asks whether it was about listening);
// a question not listed is a mistake in the spec.
export const judgeWith =
	(answers: Partial<Record<JudgeKey, string>>): Judge =>
	async ({ key }) => {
		const answer = answers[key];

		if (answer === undefined) {
			throw new Error(`the judge was asked ${key}, which the spec did not expect`);
		}

		return answer as never;
	};

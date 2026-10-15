// The composer's model chip, pure: a model id said short ("claude-opus-5-5[1m]" → "Opus 5.5 · 1M"),
// and the models its menu offers. The ids go to Claude Code as they are (set_model).
export interface ModelChoice {
	id: string;
	hint: string;
}

export const MODEL_CHOICES: ModelChoice[] = [
	{ id: 'claude-opus-5-5[1m]', hint: 'The most capable; long context' },
	{ id: 'claude-sonnet-5-5', hint: 'Faster, for routine work' },
	{ id: 'claude-haiku-5-5', hint: 'Fastest, for small edits' },
];

const FAMILY_ID = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?(\[1m\])?$/i;

const capitalize = (word: string): string => `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

// A family alias ("opus") or an id crew knows the shape of; anything else is said as it is.
export const describeModel = (id: string): string => {
	const match = FAMILY_ID.exec(id);

	if (match) {
		const [, family = '', major, minor, oneMillion] = match;

		return `${capitalize(family)} ${major}.${minor}${oneMillion ? ' · 1M' : ''}`;
	}

	return /^[a-z]+$/i.test(id) ? capitalize(id) : id;
};

const ONE_MILLION = 1_000_000;

// The chip's words: the reported id said short, with the 1M window when the context meter's reading
// shows it.
export const describeSessionModel = (id: string, windowTokens: number | null): string => {
	const said = describeModel(id);

	return windowTokens !== null && windowTokens >= ONE_MILLION && !said.endsWith(' · 1M')
		? `${said} · 1M`
		: said;
};

// The menu's choice the session is on. Claude Code leaves [1m] out of the id it reports, so the window
// comes from the context reading: Opus at 200k is not the 1M choice, and picking that one switches it.
export const isCurrentChoice = (
	choiceId: string,
	model: string,
	windowTokens: number | null,
): boolean => describeModel(choiceId) === describeSessionModel(model, windowTokens);

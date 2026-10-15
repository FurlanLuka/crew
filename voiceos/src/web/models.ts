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

// Two ids for the same model (with or without a date stamp) are the same pick.
export const isSameModel = (a: string, b: string): boolean => describeModel(a) === describeModel(b);

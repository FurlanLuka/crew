// The composer's model chip, pure: a model id said short ("claude-opus-5-5[1m]" → "Opus 5.5 · 1M"),
// and which of the models the session lists it runs on. The ids go to Claude Code as they are
// (set_model).
import type { SessionModel } from '../shared/protocol.js';

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

// The same model however it was named: no window suffix, no date.
const toBareId = (id: string): string => id.replace(/\[1m\]$/i, '').replace(/-\d{8}$/, '');

// The row the session is on. A /model pick reports the row's own id ("opus"); a start reports the full
// id, which a named model's row covers before "default" does.
export const findCurrentModel = (models: SessionModel[], model: string): SessionModel | null => {
	const bare = toBareId(model);
	const covering = models.filter((row) => row.resolved && toBareId(row.resolved) === bare);

	return (
		models.find((row) => row.id === model) ??
		covering.find((row) => row.id !== 'default') ??
		covering[0] ??
		null
	);
};

// The full id behind what the session reports: an alias picked from the menu is said as the model it
// runs on ("opus" → "Opus 5.5").
export const readChipModel = (models: SessionModel[], model: string): string =>
	models.find((row) => row.id === model)?.resolved ?? model;

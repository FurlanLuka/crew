// The languages the developer speaks to Voice OS: Soniox is told to expect them. A short list of
// common ones, by their Soniox code; English alone unless the developer picks others.
export const SPOKEN_LANGUAGES = [
	{ code: 'en', name: 'English' },
	{ code: 'de', name: 'German' },
	{ code: 'fr', name: 'French' },
	{ code: 'es', name: 'Spanish' },
	{ code: 'it', name: 'Italian' },
	{ code: 'pt', name: 'Portuguese' },
	{ code: 'nl', name: 'Dutch' },
	{ code: 'pl', name: 'Polish' },
	{ code: 'sl', name: 'Slovenian' },
	{ code: 'hr', name: 'Croatian' },
	{ code: 'sr', name: 'Serbian' },
	{ code: 'cs', name: 'Czech' },
	{ code: 'sv', name: 'Swedish' },
	{ code: 'ja', name: 'Japanese' },
	{ code: 'zh', name: 'Chinese' },
	{ code: 'hi', name: 'Hindi' },
] as const;

export const DEFAULT_LANGUAGES = ['en'];

const KNOWN = new Set<string>(SPOKEN_LANGUAGES.map((language) => language.code));

// Known codes, each once, in the list's order; never empty.
export const toLanguages = (codes: unknown): string[] => {
	const picked = Array.isArray(codes)
		? new Set(codes.filter((code) => typeof code === 'string'))
		: new Set();
	const known = SPOKEN_LANGUAGES.map((language) => language.code).filter(
		(code) => picked.has(code) && KNOWN.has(code),
	);

	return known.length > 0 ? known : DEFAULT_LANGUAGES;
};

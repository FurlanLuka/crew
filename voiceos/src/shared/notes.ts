// The developer's own notes, one list per workspace: what the page, the files and the tools agree on.

// Never a workspace's key (toNotesKey turns parentheses into dashes): a workspace named "general" keeps its own.
export const GENERAL_NOTES = '(general)';

export const nameNotes = (key: string): string => (key === GENERAL_NOTES ? 'general' : key);

const UNSAFE_PATTERN = /[^a-z0-9._-]+/g;

export const toNotesKey = (name: string): string =>
	// One spelling for a workspace wherever it comes from: a ref, a spoken name, a file name.
	name === GENERAL_NOTES
		? name
		: name.trim().toLowerCase().replace(/\s+/g, '-').replace(UNSAFE_PATTERN, '-') || GENERAL_NOTES;

export const readWorkspace = (ref: string | null | undefined): string =>
	// "store-front/main" → "store-front"; the pinned setup session and no session → general.
	ref?.includes('/') ? toNotesKey(ref.split('/')[0] ?? '') : GENERAL_NOTES;

export const toNotesFileName = (key: string): string =>
	key === GENERAL_NOTES ? '_general.md' : `${key}.md`;

export const fromNotesFileName = (fileName: string): string | null => {
	if (!fileName.endsWith('.md')) {
		return null;
	}

	return fileName === '_general.md' ? GENERAL_NOTES : fileName.slice(0, -'.md'.length);
};

const STAMP_PATTERN = /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} — /;

export const readNoteText = (line: string): string =>
	// Read back aloud, a note is its words: no dash, date or time.
	line.replace(STAMP_PATTERN, '').replace(/^- /, '');

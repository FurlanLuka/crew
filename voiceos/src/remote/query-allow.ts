// What a remote may run on the main: reading Voice OS's logs, notes and debug notes, and nothing
// that changes anything. Never --local: the main answers for every machine. Pure.

type QueryKind = 'logs' | 'debug-notes' | 'debug-notes show' | 'notes';

// Mirrors queryFlags in crew/cmd_voice_query.go: the two change together. --json is global.
const QUERY_FLAGS: Record<QueryKind, string[]> = {
	logs: ['--since', '--until', '--cat', '--level', '--grep', '--lines', '--machine', '--exclude'],
	'debug-notes': ['--since', '--until', '--grep', '--lines'],
	'debug-notes show': ['--around'],
	notes: ['--since', '--grep', '--lines', '--all'],
};

const BARE_FLAGS = new Set(['--all']);
const MAX_QUERY_LINES = 1000;

const COMMANDS = new Set(['logs', 'debug-notes', 'notes']);

const isFlagAllowed = (kind: QueryKind, arg: string): boolean => {
	if (arg === '--json') {
		return true;
	}

	const equals = arg.indexOf('=');
	const name = equals < 0 ? arg : arg.slice(0, equals);
	const value = equals < 0 ? null : arg.slice(equals + 1);

	if (!QUERY_FLAGS[kind].includes(name)) {
		return false;
	}

	if (BARE_FLAGS.has(name)) {
		return value === null;
	}

	if (name === '--lines') {
		return (
			value !== null &&
			/^\d{1,4}$/.test(value) &&
			Number(value) >= 1 &&
			Number(value) <= MAX_QUERY_LINES
		);
	}

	return Boolean(value);
};

const arePositionalsAllowed = (kind: QueryKind, positionals: string[]): boolean => {
	switch (kind) {
		case 'logs':
		case 'debug-notes':
			return positionals.length === 0;
		case 'debug-notes show':
			return positionals.length === 1 && /^\d+$/.test(positionals[0] ?? '');
		case 'notes':
			return positionals.length <= 1;
	}
};

export const isAllowedQuery = (args: string[]): boolean => {
	const [voice, command, ...afterCommand] = args;

	if (voice !== 'voice' || !command || !COMMANDS.has(command)) {
		return false;
	}

	// `show` counts only right after debug-notes, as crew parses it.
	const isShow = command === 'debug-notes' && afterCommand[0] === 'show';
	const kind = (isShow ? 'debug-notes show' : command) as QueryKind;
	const rest = isShow ? afterCommand.slice(1) : afterCommand;

	const positionals = rest.filter((arg) => !arg.startsWith('-'));
	const flags = rest.filter((arg) => arg.startsWith('-'));

	return (
		arePositionalsAllowed(kind, positionals) && flags.every((flag) => isFlagAllowed(kind, flag))
	);
};

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

// A dev push from a remote (crew voice dev push there): it reads the machines, hands its build to the
// main, and follows the push. The one request here that changes anything: the main then runs the push,
// and names the remote as its source itself (withSource) — a remote never says who it is.
const DEV_VERSION = /^dev-[0-9a-f]{4,40}(?:-dirty)?$/;
const BUILD_DIR = /^\/[\w./-]{1,400}$/;

const isAllowedDevQuery = (rest: string[]): boolean => {
	const [sub, ...args] = rest;

	switch (sub) {
		case 'targets':
		case 'status':
			return args.every((arg) => arg === '--json');
		case '_handoff':
			return (
				args.length === 2 &&
				DEV_VERSION.test(args[0] ?? '') &&
				BUILD_DIR.test(args[1] ?? '') &&
				!(args[1] ?? '').includes('..')
			);
		default:
			return false;
	}
};

// What the main runs for a remote's query: a handoff gets the asking machine as its source.
export const withSource = (args: string[], machine: string): string[] =>
	args[1] === 'dev' && args[2] === '_handoff' ? [...args, `--source=${machine}`] : args;

export const isAllowedQuery = (args: string[]): boolean => {
	const [voice, command, ...afterCommand] = args;

	if (voice === 'voice' && command === 'dev') {
		return isAllowedDevQuery(afterCommand);
	}

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

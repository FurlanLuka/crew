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

// A dev push from a remote (crew server dev push there): it reads the machines, hands its version to
// the main, and follows the push. The one request here that changes anything — the main then fetches
// that remote's build from its own push dir and runs the push. A remote names neither a path nor
// itself: the main adds --source (withSource).
const DEV_VERSION = /^dev-[0-9a-f]{4,40}(?:-dirty-[0-9a-f]{8})?$/;

const isAllowedDevQuery = (rest: string[]): boolean => {
	const [sub, ...args] = rest;

	switch (sub) {
		case '_targets':
		case 'status':
			return args.every((arg) => arg === '--json');
		case '_handoff':
			return args.length === 1 && DEV_VERSION.test(args[0] ?? '');
		default:
			return false;
	}
};

// A message a session on a remote posts to Discord (crew server discord send there): the remote has
// no token, so it stages the message and the main fetches the stage over scp and posts it. The remote
// names only the stage's id; the main adds --source. Whether Discord is set up is read too, so a
// remote session is told of send only when it would post.
const DISCORD_STAGE = /^[0-9a-f]{16}$/;

const isAllowedDiscordQuery = (rest: string[]): boolean => {
	const [sub, ...args] = rest;
	const flags = args.filter((arg) => arg !== '--json');

	switch (sub) {
		case 'status':
			return flags.length === 0;
		case '_send':
			return flags.length === 1 && DISCORD_STAGE.test(flags[0] ?? '');
		default:
			return false;
	}
};

// A staged Discord message is fetched over scp and posted (up to 10 files of 10 MB): it gets minutes
// where a read gets seconds. The main runs crew for this long; the remote's daemon waits a little
// longer, and crew there longer still (voice.discordSendWait).
export const DISCORD_SEND_QUERY_MS = 150_000;
export const DISCORD_SEND_WAIT_MS = 160_000;

export const isDiscordSendQuery = (args: string[]): boolean =>
	args[0] === 'voice' && args[1] === 'discord' && args[2] === '_send';

const isSourcedQuery = (args: string[]): boolean =>
	(args[1] === 'dev' && args[2] === '_handoff') || (args[1] === 'discord' && args[2] === '_send');

// What the main runs for a remote's query: a handoff or a staged message gets the asking machine.
export const withSource = (args: string[], machine: string): string[] =>
	isSourcedQuery(args) ? [...args, `--source=${machine}`] : args;

export const isAllowedQuery = (args: string[]): boolean => {
	const [voice, command, ...afterCommand] = args;

	if (voice === 'voice' && command === 'dev') {
		return isAllowedDevQuery(afterCommand);
	}

	if (voice === 'voice' && command === 'discord') {
		return isAllowedDiscordQuery(afterCommand);
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

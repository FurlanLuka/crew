// How a tool call is said aloud in a permission ask: what it does, in a few words, never the full
// command or a path — "decentrl wants to search the SDK for vouch", not the grep with every directory.
const MAX_SPOKEN_WORDS = 12;

// Their subcommand says what the call does: "git push", not "git".
const PROGRAMS_WITH_SUBCOMMANDS = new Set([
	'git',
	'gh',
	'bun',
	'npm',
	'pnpm',
	'yarn',
	'crew',
	'docker',
	'go',
	'cargo',
	'make',
	'kubectl',
]);

const readText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const capWords = (text: string): string => {
	const words = text.split(/\s+/).filter(Boolean);

	return words.length > MAX_SPOKEN_WORDS
		? `${words.slice(0, MAX_SPOKEN_WORDS).join(' ')}…`
		: words.join(' ');
};

const readFileName = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? 'a file';

const readHost = (url: string): string => {
	try {
		return new URL(url).hostname.replace(/^www\./, '');
	} catch {
		return 'the web';
	}
};

export const describeShellAloud = (command: string): string => {
	// "cd app && FOO=1 bun test --watch | tee out" → "bun test".
	const first =
		command
			.split(/&&|\|\||;|\|/)
			.map((part) => part.trim())
			.find((part) => part && !/^cd\s/.test(part)) ?? '';
	const words = first.split(/\s+/).filter((word) => !/^[A-Z_][A-Z0-9_]*=/.test(word));
	const program = readFileName(words[0] ?? '');
	const subcommand = words[1];

	if (!words[0]) {
		return 'run a command';
	}

	return PROGRAMS_WITH_SUBCOMMANDS.has(program) && subcommand && !subcommand.startsWith('-')
		? `run ${program} ${subcommand}`
		: `run ${program}`;
};

const lowerFirst = (text: string): string =>
	text ? `${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;

export const describeToolAloud = (toolName: string, input: Record<string, unknown>): string => {
	switch (toolName) {
		case 'Bash': {
			// Claude writes what the command is for: that is what the developer wants to hear.
			const description = readText(input.description).replace(/[.]+$/, '');

			return description
				? capWords(lowerFirst(description))
				: describeShellAloud(readText(input.command));
		}
		case 'Read':
			return `read ${readFileName(readText(input.file_path))}`;
		case 'Edit':
		case 'MultiEdit':
			return `edit ${readFileName(readText(input.file_path))}`;
		case 'Write':
			return `write ${readFileName(readText(input.file_path))}`;
		case 'NotebookEdit':
			return 'edit a notebook';
		case 'Grep':
			return 'search the code';
		case 'Glob':
			return 'look for files';
		case 'WebFetch':
			return `fetch a page from ${readHost(readText(input.url))}`;
		case 'WebSearch':
			return 'search the web';
		case 'Agent':
		case 'Task':
			return 'start a subagent';
		case 'ExitPlanMode':
			return 'present its plan';
		default:
			return toolName.startsWith('mcp__')
				? `use ${toolName.split('__').slice(1).join(' ').replace(/[_-]+/g, ' ')}`
				: `use ${toolName}`;
	}
};

// A blocked call keeps only its one-line summary ("run grep -rn …", "edit src/web/App.tsx"): said
// the same short way.
export const describeSummaryAloud = (toolName: string, summary: string): string => {
	const [verb = '', ...rest] = summary.trim().split(/\s+/);
	const target = rest.join(' ');

	switch (toolName) {
		case 'Bash':
			return describeShellAloud(summary.replace(/^run\s+/, ''));
		case 'Read':
		case 'Edit':
		case 'MultiEdit':
		case 'Write':
			return `${verb} ${readFileName(target)}`;
		default:
			return capWords(summary);
	}
};

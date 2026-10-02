// The setup chat's "✓ recorded" lines, pure: read from the crew commands Claude ran, never from its
// prose.
import type { StreamItem } from '../../shared/protocol.js';

// A crew command line, split like a shell would: quotes kept together, quotes dropped.
export const splitCommandLine = (line: string): string[] => {
	const words: string[] = [];
	let current = '';
	let quote: '"' | "'" | null = null;
	let hasWord = false;

	for (const char of line) {
		if (quote) {
			if (char === quote) {
				quote = null;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			quote = char;
			hasWord = true;
		} else if (/\s/.test(char)) {
			if (hasWord || current) {
				words.push(current);
			}

			current = '';
			hasWord = false;
		} else {
			current += char;
		}
	}

	if (hasWord || current) {
		words.push(current);
	}

	return words;
};

const readFlag = (args: string[], name: string): string | null => {
	const prefix = `--${name}=`;

	return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
};

const positional = (args: string[]): string[] => args.filter((arg) => !arg.startsWith('-'));

// What a successful crew command recorded, in Set up's words; null for a read. Never a value:
// bindings and pinned values can carry credentials, so only their names are said.
export const describeRecorded = (command: string): string | null => {
	const words = splitCommandLine(command.replace(/^run\s+/, '').trim());
	const start = words.indexOf('crew');

	if (start < 0) {
		return null;
	}

	const [verb, noun, ...rest] = words.slice(start + 1);
	const args = positional(rest);

	if (verb === 'add' && noun === 'project') {
		const setup = readFlag(rest, 'setup');
		const envCmd = readFlag(rest, 'env-cmd');

		if (setup !== null || envCmd !== null) {
			return setup !== null ? `Install: ${setup || 'none'}` : 'Env command recorded';
		}

		return args[0] ? `Added ${args[0]}` : 'Added a project';
	}

	if (verb === 'add' && noun === 'binding') {
		const name = readFlag(rest, 'var') ?? args[1];
		const scope = args[0]?.includes('/') ? ` (${args[0].split('/')[1]} only)` : '';

		return name ? `Environment: ${name}${scope}` : 'Environment recorded';
	}

	if (verb === 'add' && noun === 'workspace') {
		return args[0]
			? `Workspace: ${args[0]}${args.length > 1 ? ` (${args.slice(1).join(', ')})` : ''}`
			: null;
	}

	if (verb === 'add' && noun === 'worktree') {
		return args[0] ? `Worktree: ${args[0]}` : null;
	}

	if (verb === 'add' && noun === 'override') {
		const name = args[1]?.split('=')[0];

		return name ? `Pinned value: ${name.replace(/^[^.]*\./, '')} in ${args[0]}` : null;
	}

	if (verb === 'dev' && noun === 'add') {
		const name = readFlag(rest, 'name') ?? args[1];
		const port = readFlag(rest, 'port');
		const renamed = readFlag(rest, 'rename');

		if (renamed && name && renamed !== name) {
			return `Renamed dev server ${renamed} → ${name}`;
		}

		return name
			? `Dev server: ${name}${port && port !== '0' ? ` :${port}` : " (no port, it doesn't listen)"}`
			: null;
	}

	if (verb === 'dev' && noun === 'rm') {
		return args[1] ? `Removed dev server ${args[1]}` : null;
	}

	if (verb === 'rm' && noun) {
		return `Removed ${noun}${args[0] ? ` ${args.join(' ')}` : ''}`;
	}

	if (verb === 'check' && noun === 'project') {
		return args[0] ? `Checked ${args[0]}` : null;
	}

	if (verb === 'rename' && noun === 'worktree') {
		return args[0] && args[1] ? `Renamed ${args[0]} to ${args[1]}` : null;
	}

	if (verb === 'duplicate') {
		return noun && args[0] ? `Duplicated ${noun} as ${args[0]}` : null;
	}

	if ((verb === 'voice' || verb === 'server') && noun === 'machines' && rest[0] === 'add') {
		return args[1] ? `Machine: ${readFlag(rest, 'name') ?? args[1]} (${args[1]})` : null;
	}

	if (verb === 'config' && noun === 'set') {
		return args[0] ? `Setting: ${args[0]}` : null;
	}

	if (verb === 'import') {
		return 'Imported';
	}

	return null;
};

export interface RecordedLine {
	// The tool line it follows in the stream.
	afterId: string;
	text: string;
}

// "✓ recorded" lines from the setup session's own successful crew calls: from the command, never
// from what Claude says it did.
export const listRecordedLines = (stream: StreamItem[]): RecordedLine[] => {
	const lines: RecordedLine[] = [];

	stream.forEach((item, index) => {
		if (item.kind !== 'tool' || !item.summary.startsWith('run ')) {
			return;
		}

		const result = stream
			.slice(index + 1)
			.find((later) => later.kind === 'tool_result' || later.kind === 'tool');

		if (result?.kind !== 'tool_result' || !result.ok) {
			return;
		}

		const text = describeRecorded(item.summary);

		if (text) {
			lines.push({ afterId: item.id, text });
		}
	});

	return lines;
};

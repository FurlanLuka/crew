// How a tool call reads in one line: in the stream, a permission ask, a sub-agent's step.
const MAX_SUMMARY_CHARS = 140;

export const clipText = (text: string, limit = MAX_SUMMARY_CHARS): string => {
	const flat = text.replace(/\s+/g, ' ').trim();

	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

export const readString = (value: unknown): string => {
	return typeof value === 'string' ? value : '';
};

const shortenPath = (path: string, cwd?: string): string => {
	if (cwd && path.startsWith(`${cwd}/`)) {
		return path.slice(cwd.length + 1);
	}

	const parts = path.split('/');

	return parts.length > 3 ? parts.slice(-3).join('/') : path;
};

export const summarizeTool = (
	name: string,
	input: Record<string, unknown>,
	cwd?: string,
): string => {
	switch (name) {
		case 'Bash':
			return `run ${clipText(readString(input.command))}`;
		case 'Read':
			return `read ${shortenPath(readString(input.file_path), cwd)}`;
		case 'Edit':
		case 'MultiEdit':
			return `edit ${shortenPath(readString(input.file_path), cwd)}`;
		case 'Write':
			return `write ${shortenPath(readString(input.file_path), cwd)}`;
		case 'NotebookEdit':
			return `edit notebook ${shortenPath(readString(input.notebook_path), cwd)}`;
		case 'Grep':
			return `search for ${clipText(readString(input.pattern), 60)}`;
		case 'Glob':
			return `find files matching ${clipText(readString(input.pattern), 60)}`;
		case 'WebFetch':
			return `fetch ${clipText(readString(input.url), 80)}`;
		case 'WebSearch':
			return `search the web for ${clipText(readString(input.query), 60)}`;
		case 'Agent':
		case 'Task':
			return `start a subagent: ${clipText(readString(input.description), 80)}`;
		case 'ExitPlanMode':
			return 'present its plan';
		case 'AskUserQuestion':
			return 'ask you a question';
		default:
			return name.startsWith('mcp__')
				? `use ${name.split('__').slice(1).join(' ')}`
				: `use ${name}`;
	}
};

export const getContentBlocks = (message: {
	message?: { content?: unknown };
}): Record<string, unknown>[] => {
	const content = message.message?.content;

	return Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
};

// How the prompts docked above the voice bar read: a permission's title and body, a shell command
// split for display, what "Always allow" would remember, a /clear or /compact confirm, and the words
// each prompt is answered with by voice. Pure: the sheets in components/ draw what these return.
import type { GuardedCommand, PermissionSuggestion } from '../shared/protocol.js';
import { withoutModeChanges } from '../state/session-modes.js';

export interface CommandSegment {
	text: string;
	role: 'program' | 'operator' | 'arg';
}

export type PermissionBody =
	| { kind: 'command'; segments: CommandSegment[] }
	| { kind: 'text'; text: string }
	| { kind: 'fields'; fields: { key: string; value: string }[] };

interface PermissionCopy {
	title: string;
	reason: string | null;
	body: PermissionBody | null;
}

interface PermissionSource {
	toolName: string;
	input: Record<string, unknown>;
	// The one-line summary, built where the session runs: its path is short against the cwd.
	summary: string;
}

const OPERATORS = ['&&', '||', '|', ';', '\n'];
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WORD = /(?:[^\s"']+|"[^"]*"?|'[^']*'?)+/g;
// In a heredoc, a $( ) or backticks, an operator may belong to the inner command: splitting there
// would light up words that are not programs, so such a command keeps only its first word bright.
const NESTED = /<<|\$\(|`/;

const markProgram = (chunk: string): CommandSegment[] => {
	for (const match of chunk.matchAll(WORD)) {
		if (ASSIGNMENT.test(match[0])) {
			continue;
		}

		const start = match.index;
		const end = start + match[0].length;

		return [
			{ text: chunk.slice(0, start), role: 'arg' as const },
			{ text: match[0], role: 'program' as const },
			{ text: chunk.slice(end), role: 'arg' as const },
		].filter((segment) => segment.text !== '');
	}

	return chunk === '' ? [] : [{ text: chunk, role: 'arg' }];
};

const readOperatorAt = (command: string, index: number): string | null =>
	OPERATORS.find((operator) => command.startsWith(operator, index)) ?? null;

// Quote-aware: an operator inside quotes stays in its argument. Joined, the texts are the command.
export const splitCommand = (command: string): CommandSegment[] => {
	if (NESTED.test(command)) {
		return markProgram(command);
	}

	const segments: CommandSegment[] = [];
	let chunkStart = 0;
	let quote: string | null = null;
	let index = 0;

	while (index < command.length) {
		const char = command[index] ?? '';

		if (quote) {
			if (char === '\\' && quote === '"') {
				index += 2;
				continue;
			}

			quote = char === quote ? null : quote;
			index += 1;
			continue;
		}

		if (char === '\\') {
			index += 2;
			continue;
		}

		if (char === '"' || char === "'") {
			quote = char;
			index += 1;
			continue;
		}

		const operator = readOperatorAt(command, index);

		if (!operator) {
			index += 1;
			continue;
		}

		segments.push(...markProgram(command.slice(chunkStart, index)), {
			text: operator,
			role: 'operator',
		});
		index += operator.length;
		chunkStart = index;
	}

	return [...segments, ...markProgram(command.slice(chunkStart))];
};

const readText = (value: unknown): string | null =>
	typeof value === 'string' && value.trim() !== '' ? value : null;

// The summary is "<verb> <object>": the sheet's title already says the verb.
const stripVerb = (summary: string, verb: string): string =>
	summary.startsWith(`${verb} `) ? summary.slice(verb.length + 1) : summary;

const FIELDS_SHOWN = 4;
const FIELD_CHARS = 120;

const clip = (text: string, limit: number): string => {
	const flat = text.replace(/\s+/g, ' ').trim();

	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

// A tool without a known shape (an MCP tool) shows what it was called with, as key and value.
const readFields = (input: Record<string, unknown>): PermissionBody | null => {
	const fields = Object.entries(input)
		.filter(
			([, value]) =>
				typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
		)
		.slice(0, FIELDS_SHOWN)
		.map(([key, value]) => ({ key, value: clip(String(value), FIELD_CHARS) }));

	return fields.length > 0 ? { kind: 'fields', fields } : null;
};

// A summary with nothing after its verb (a call without its path or command) shows no empty box.
const readTextBody = (text: string): PermissionBody | null =>
	text.trim() === '' ? null : { kind: 'text', text };

const describeToolName = (toolName: string): string =>
	toolName.startsWith('mcp__') ? toolName.split('__').slice(1).join(' ') : toolName;

export const describePermission = ({
	toolName,
	input,
	summary,
}: PermissionSource): PermissionCopy => {
	switch (toolName) {
		case 'Bash': {
			const command = readText(input.command);

			return {
				title: 'Run this command?',
				reason: readText(input.description),
				body: command
					? { kind: 'command', segments: splitCommand(command) }
					: readTextBody(stripVerb(summary, 'run')),
			};
		}
		case 'Edit':
		case 'MultiEdit':
			return {
				title: 'Edit this file?',
				reason: null,
				body: readTextBody(stripVerb(summary, 'edit')),
			};
		case 'NotebookEdit':
			return {
				title: 'Edit this notebook?',
				reason: null,
				body: readTextBody(stripVerb(summary, 'edit notebook')),
			};
		case 'Write':
			return {
				title: 'Write this file?',
				reason: null,
				body: readTextBody(stripVerb(summary, 'write')),
			};
		case 'WebFetch': {
			const prompt = readText(input.prompt);

			return {
				title: 'Open this page?',
				reason: prompt ? clip(prompt, FIELD_CHARS) : null,
				body: readTextBody(readText(input.url) ?? stripVerb(summary, 'fetch')),
			};
		}
		case 'WebSearch':
			return {
				title: 'Search the web?',
				reason: null,
				body: readTextBody(readText(input.query) ?? stripVerb(summary, 'search the web for')),
			};
		default:
			return { title: `Use ${describeToolName(toolName)}?`, reason: null, body: readFields(input) };
	}
};

interface AlwaysCopy {
	// The first thing it would remember (a command prefix, a tool, a folder), null when none is named.
	rule: string | null;
	more: number;
	// Everything it would remember, for the button's tooltip.
	title: string;
}

const RULE_CHARS = 40;

const readRecords = (value: unknown): Record<string, unknown>[] =>
	Array.isArray(value)
		? value.filter(
				(item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
			)
		: [];

const nameSuggestion = (suggestion: PermissionSuggestion): string[] => {
	if (suggestion.type === 'addRules' && suggestion.behavior !== 'deny') {
		return readRecords(suggestion.rules).flatMap((rule) => {
			const content = readText(rule.ruleContent);
			const tool = readText(rule.toolName);

			return content ? [content.replace(/:\*$/, '')] : tool ? [tool] : [];
		});
	}

	if (suggestion.type === 'addDirectories' && Array.isArray(suggestion.directories)) {
		return suggestion.directories
			.filter((dir): dir is string => typeof dir === 'string')
			.map((dir) => `in ${dir}`);
	}

	return [];
};

// Null when "Always allow" would remember nothing: no button then. The label never promises less
// than the answer grants, so a second rule shows as "+1 more".
export const describeAlways = (suggestions: PermissionSuggestion[]): AlwaysCopy | null => {
	const remembered = withoutModeChanges(suggestions);

	if (remembered.length === 0) {
		return null;
	}

	const names = remembered.flatMap(nameSuggestion);
	const [first] = names;

	return {
		rule: first ? clip(first, RULE_CHARS) : null,
		more: Math.max(0, names.length - 1),
		title: names.length > 0 ? `Always allow: ${names.join(', ')}` : 'Always allow this from now on',
	};
};

interface ConfirmCopy {
	title: string;
	reason: string;
	verb: string;
	// The typed command when it carries more than the bare command (/compact's instructions).
	extra: string | null;
}

export const describeConfirm = ({
	command,
	text,
}: {
	command: GuardedCommand;
	text: string;
}): ConfirmCopy => {
	const typed = text.trim();
	const extra = typed === '' || typed === `/${command}` ? null : typed;

	return command === 'clear'
		? {
				title: 'Clear the conversation?',
				reason: 'It starts fresh. Files and commits stay.',
				verb: 'Clear',
				extra,
			}
		: {
				title: 'Compact the conversation?',
				reason: 'It keeps a summary and carries on.',
				verb: 'Compact',
				extra,
			};
};

// What each prompt is answered with by voice (tools/answer.ts takes yes, always, no or the words).
export const SAY = {
	permission: 'Say yes, always or no',
	permissionNoAlways: 'Say yes or no',
	question: 'Say an option, or your own answer',
	plan: 'Say approve, or what to change',
	confirm: 'Say yes or no',
	redirect: 'Say yes to switch now, or no for after',
	denied: 'Say allow it',
	peer: 'Say yes or no',
} as const;

// As far as tools/answer.ts takes an option by its number word.
const NUMBER_WORDS = ['one', 'two', 'three', 'four', 'five'];

// The word that picks an option by voice; options past five are said by name.
export const readOptionWord = (index: number): string | null => NUMBER_WORDS[index] ?? null;

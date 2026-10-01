import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FORWARD_TOOL, MACHINE_TOOL_DEFINITIONS, TOOL_DEFINITIONS } from './definitions.js';

// The commands page is written by hand; this only checks that no kernel tool is left out of it.
const COMMANDS_PAGE = join(import.meta.dir, '../../../docs/guides/voice-os-commands.md');

describe('docs/guides/voice-os-commands.md', () => {
	const headings = readFileSync(COMMANDS_PAGE, 'utf8')
		.split('\n')
		.filter((line) => line.startsWith('### '));
	const toolNames = [
		...new Set(
			[FORWARD_TOOL, ...TOOL_DEFINITIONS, ...MACHINE_TOOL_DEFINITIONS].map((tool) => tool.name),
		),
	];

	it.each(toolNames)('`%s` has its section', (name) =>
		expect(headings.some((heading) => heading.endsWith(`— \`${name}\``))).toBe(true),
	);
});

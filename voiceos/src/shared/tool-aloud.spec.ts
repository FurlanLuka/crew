import { describe, expect, it } from 'bun:test';
import { describeShellAloud, describeSummaryAloud, describeToolAloud } from './tool-aloud.js';

describe('describeShellAloud', () => {
	it.each([
		['grep -rn "vouch" packages/sdk/src apps/social/src | grep -v test', 'run grep'],
		['git push origin main', 'run git push'],
		['cd apps/web && FOO=1 bun test --watch', 'run bun test'],
		['/usr/local/bin/rg vouch', 'run rg'],
		['npm --version', 'run npm'],
		['', 'run a command'],
	])('%p → %p', (command, spoken) => expect(describeShellAloud(command)).toBe(spoken));
});

describe('describeToolAloud', () => {
	it.each([
		[
			'Bash',
			{ command: 'rm -rf dist', description: 'Clean the build output.' },
			'clean the build output',
		],
		['Edit', { file_path: '/Users/dev/code/app/src/web/BottomBar.tsx' }, 'edit BottomBar.tsx'],
		['Write', { file_path: '/tmp/notes.md' }, 'write notes.md'],
		['Grep', { pattern: 'unaccounted|vouch', path: '/Users/dev/code' }, 'search the code'],
		['WebFetch', { url: 'https://www.example.com/docs/a?b=c' }, 'fetch a page from example.com'],
		['mcp__linear-server__create_issue', {}, 'use linear server create issue'],
		['SomethingNew', {}, 'use SomethingNew'],
	])('%p %p → %p', (toolName, input, spoken) =>
		expect(describeToolAloud(toolName, input)).toBe(spoken),
	);
});

describe('describeSummaryAloud', () => {
	it.each([
		['Bash', 'run grep -rn "vouch" packages/sdk/src apps/social/src', 'run grep'],
		['Edit', 'edit voiceos/src/web/App.tsx', 'edit App.tsx'],
		['WebSearch', 'search the web for soniox limits', 'search the web for soniox limits'],
	])('%p %p → %p', (toolName, summary, spoken) =>
		expect(describeSummaryAloud(toolName, summary)).toBe(spoken),
	);
});

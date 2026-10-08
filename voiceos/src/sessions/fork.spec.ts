import { describe, expect, it } from 'bun:test';
import { dropCheckpoints, hasToolUse, isTopLevelAssistant, readText } from './fork.js';

describe('dropCheckpoints', () => {
	it('a checkpoint with its spoken line before the answer → left out', () =>
		expect(dropCheckpoints(['<spoken>Tests run.</spoken>', 'The router.'])).toEqual({
			kept: ['The router.'],
			dropped: 1,
		}));

	it('an answer over several messages without spoken lines → kept whole', () =>
		expect(dropCheckpoints(['The router.', 'In src/router.'])).toEqual({
			kept: ['The router.', 'In src/router.'],
			dropped: 0,
		}));

	it('the last message is kept even with a spoken line: it is the answer', () =>
		expect(dropCheckpoints(['<spoken>It is the router.</spoken>']).kept).toEqual([
			'<spoken>It is the router.</spoken>',
		]));
});

describe('message readers', () => {
	const message = {
		type: 'assistant',
		message: {
			content: [
				{ type: 'text', text: 'one' },
				{ type: 'tool_use', id: 't', name: 'Read', input: {} },
				{ type: 'text', text: 'two' },
			],
		},
	};

	it('text blocks joined; a tool call seen; a sub-agent message is not top level', () => {
		expect(readText(message)).toBe('one\ntwo');
		expect(hasToolUse(message)).toBe(true);
		expect(isTopLevelAssistant(message)).toBe(true);
		expect(isTopLevelAssistant({ ...message, parent_tool_use_id: 'x' })).toBe(false);
	});
});

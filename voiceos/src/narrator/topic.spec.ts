import { describe, expect, it } from 'bun:test';
import { buildTopicMessage, createTopicWriter } from './topic.js';

const input = {
	label: 'store/main',
	asked: 'build notes',
	spoken: 'Notes are built.',
	body: 'x'.repeat(3000),
	topic: 'Spoken checkpoint evals',
};

describe('topic writer', () => {
	it('the message carries the current topic and what was asked and said, the body cut short', () => {
		const message = buildTopicMessage(input);

		expect(message).toContain('current topic: Spoken checkpoint evals');
		expect(message).toContain('the developer asked: build notes');
		expect(message).toContain('it said: Notes are built.');
		expect(message.length).toBeLessThan(2_300);
	});

	it('no API key → the topic stays what it was', async () =>
		expect(await createTopicWriter(null)(input)).toBe('Spoken checkpoint evals'));
});

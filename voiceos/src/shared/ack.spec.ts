import { describe, expect, it } from 'bun:test';
import { composeAckText } from './ack.js';

describe('composeAckText', () => {
	it.each<['question' | 'instruction', 'now' | 'queued' | 'starting', string | null]>([
		['instruction', 'now', null],
		['question', 'now', null],
		['instruction', 'queued', 'Okay, after its current work.'],
		['question', 'queued', null],
		['instruction', 'starting', 'Starting it up.'],
		['question', 'starting', 'Starting it up.'],
	])('%s, %s → %p: the session acks what it has seen itself', (kind, timing, text) =>
		expect(composeAckText({ kind }, timing)).toBe(text),
	);
});

import { describe, expect, it } from 'bun:test';
import { readShownText, readSpokenTag, stripSpokenTag, stripStreamingTag } from './spoken-tags.js';

describe('readSpokenTag', () => {
	it('the tag at the top of a message; asks marks a question; empty or still streaming is nothing', () => {
		expect(readSpokenTag('<spoken>Checking the logs, back shortly.</spoken>\n\nWork…')).toEqual({
			text: 'Checking the logs, back shortly.',
			isAsking: false,
		});
		expect(readSpokenTag('  <spoken asks> Push it now? </spoken>')).toEqual({
			text: 'Push it now?',
			isAsking: true,
		});
		expect(readSpokenTag('<spoken asks>What should I research?</spoken asks>\nMore.')).toEqual({
			text: 'What should I research?',
			isAsking: true,
		});
		expect(readSpokenTag('<spoken></spoken>')).toBeNull();
		expect(readSpokenTag('<spoken>Three timeouts in the')).toBeNull();
	});

	it('a tag quoted further down is just text, never said', () =>
		expect(
			readSpokenTag('Open each reply with `<spoken>…</spoken>`, like <spoken>this</spoken>.'),
		).toBeNull());
});

describe('stripping', () => {
	it('a finished message loses only its closed top tag; an unclosed one stays visible', () => {
		expect(stripSpokenTag('<spoken>Done: 3 timeouts.</spoken>\n\n## Details\nThe worker…')).toBe(
			'## Details\nThe worker…',
		);
		expect(stripSpokenTag('<spoken>Done. Details without a close')).toBe(
			'<spoken>Done. Details without a close',
		);
		expect(stripSpokenTag('Use a < b, or <spoken> in prose.')).toBe(
			'Use a < b, or <spoken> in prose.',
		);
	});

	it('a draft hides a tag still being written at the top, and nothing else', () => {
		expect(stripStreamingTag('<spoken>Three timeouts in')).toBe('');
		expect(stripStreamingTag('<spok')).toBe('');
		expect(stripStreamingTag('<spoken>Done.</spoken>\nThe det')).toBe('The det');
		expect(stripStreamingTag('Use a <')).toBe('Use a <');
	});
});

describe('readShownText', () => {
	it('an ack-only message shows its words; otherwise the text without the tag', () => {
		expect(readShownText('<spoken>Checking the logs, back shortly.</spoken>')).toBe(
			'Checking the logs, back shortly.',
		);
		expect(readShownText('<spoken>Done.</spoken>\nThe details.')).toBe('The details.');
	});
});

import { describe, expect, it } from 'bun:test';
import { findWakePhrase, gateHeard, stripLeadingWakePhrase } from './wake.js';

describe('findWakePhrase', () => {
	it.each([
		['Voice OS, tell checkout to run the tests.', 'tell checkout to run the tests.'],
		['VoiceOS, what is running?', 'what is running?'],
		['voice o s open the doc', 'open the doc'],
		['Hey Voice OS, stop.', 'stop.'],
		['Okay, voice OS — mute', 'mute'],
		['Voice OS.', ''],
		// Mid-sentence counts too: the name is rare enough in talk around the developer.
		['On the news: the voice OS market grew.', 'market grew.'],
	])('%p → %p', (text, rest) => expect(findWakePhrase(text)).toBe(rest));

	it.each([
		['Tonight on the evening news, heavy rain is expected.'],
		['The voice of the people.'],
		['voices'],
		[''],
	])('%p → no wake phrase', (text) => expect(findWakePhrase(text)).toBeNull());
});

describe('gateHeard', () => {
	it('asleep: the name opens a turn with what follows; anything else is left alone', () => {
		expect(gateHeard({ isAwake: false, text: 'Voice OS, stop.' })).toEqual({
			kind: 'wake',
			rest: 'stop.',
		});
		expect(gateHeard({ isAwake: false, text: 'Voice OS.' })).toEqual({ kind: 'wake', rest: '' });
		expect(gateHeard({ isAwake: false, text: 'Heavy rain tonight.' })).toEqual({ kind: 'drop' });
	});

	it('awake: the words are the turn, the name taken out if said again', () => {
		expect(gateHeard({ isAwake: true, text: 'Tell checkout to run the tests.' })).toEqual({
			kind: 'pass',
			text: 'Tell checkout to run the tests.',
		});
		expect(gateHeard({ isAwake: true, text: 'Voice OS, open the doc' })).toEqual({
			kind: 'pass',
			text: 'open the doc',
		});
		// The name split across segments: each half at the start is the name.
		expect(gateHeard({ isAwake: true, text: 'Voice.' })).toEqual({
			kind: 'pass',
			text: '',
			isNameHead: true,
		});
		expect(gateHeard({ isAwake: true, text: 'OS, open the doc.', isAfterNameHead: true })).toEqual({
			kind: 'pass',
			text: 'open the doc.',
		});
		// Only right after "Voice": otherwise "OS" is the developer's word.
		expect(gateHeard({ isAwake: true, text: 'OS updates broke the build.' })).toEqual({
			kind: 'pass',
			text: 'OS updates broke the build.',
		});
		expect(gateHeard({ isAwake: true, text: 'Check the voice OS logs.' })).toEqual({
			kind: 'pass',
			text: 'Check the voice OS logs.',
		});
	});
});

describe('stripLeadingWakePhrase', () => {
	it.each([
		['Voice. OS, open the doc.', 'open the doc.'],
		['Hey Voice OS, stop.', 'stop.'],
		['Tell it about the voice OS market.', 'Tell it about the voice OS market.'],
		['Open the doc.', 'Open the doc.'],
	])('%p → %p', (text, sent) => expect(stripLeadingWakePhrase(text)).toBe(sent));
});

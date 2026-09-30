import { describe, expect, it } from 'bun:test';
import { GRID, type State, type VoiceEntry } from '../shared/protocol.js';
import { createInitialState } from '../state/reducer.js';
import { describeRecentAction, RECENT_ACTION_MS } from './recent-action.js';

const NOW = 1_000_000;
const NOTE_SAID =
	'Can you also add a debug note that my last question was super long and only the request was forwarded?';
const BACK_REFERENCE = 'Can you also tell the session to check this debug note?';

const entry = (patch: Partial<VoiceEntry>): VoiceEntry => ({
	utterance: NOTE_SAID,
	did: ['debug_note "The last question was long…"'],
	reply: 'Debug note saved.',
	at: NOW - 10_000,
	...patch,
});

const withLog = (voiceLog: State['voiceLog']): State => ({ ...createInitialState(), voiceLog });

const describeFor = (state: State, utterance: string | undefined = BACK_REFERENCE) =>
	describeRecentAction(state, { ref: 'crew/main', screen: 'crew/main', now: NOW, utterance });

describe('describeRecentAction', () => {
	const lineFor = (utterance: string, summary: string): string =>
		`(Voice OS note — just before this, the developer told Voice OS: "${utterance}", and Voice OS ${summary}.)`;
	const summaryOf = (did: string[], screen = 'crew/main') =>
		describeFor(withLog({ [screen]: [entry({ utterance: 'Do the thing.', did })] }));

	it('a debug note saved just before "check this debug note" → the line carries its words', () => {
		expect(describeFor(withLog({ 'crew/main': [entry({})] }))).toBe(
			lineFor(NOTE_SAID, 'saved it as a debug note'),
		);
	});

	it('a note saved on the grid → the grid counts too', () => {
		expect(summaryOf(['note "use the staging db"'], GRID)).toBe(
			lineFor('Do the thing.', 'saved it as a note'),
		);
	});

	it('each content-carrying action → its own summary', () => {
		const cases: [string[], string, string][] = [
			[
				['queued_message now checkout-api/main'],
				'crew/main',
				'sent the words queued for checkout-api/main now',
			],
			[
				['queued_message drop checkout-api/main'],
				'crew/main',
				'took back the words queued for checkout-api/main',
			],
			[['answer yes checkout-api/main ""'], 'crew/main', "answered checkout-api/main's question"],
			[
				['allow_denied checkout-api/main'],
				'crew/main',
				'allowed a blocked action for checkout-api/main',
			],
		];

		for (const [did, screen, summary] of cases) {
			expect(summaryOf(did, screen)).toBe(lineFor('Do the thing.', summary));
		}
	});

	it('a forward to the screen session, then words for another session → "sent it to" the first', () => {
		expect(
			describeRecentAction(
				withLog({
					'crew/main': [entry({ utterance: 'Do the thing.', did: ['forward "Pin it."'] })],
				}),
				{ ref: 'admin/main', screen: 'crew/main', now: NOW, utterance: BACK_REFERENCE },
			),
		).toBe(lineFor('Do the thing.', 'sent it to crew/main'));
	});

	it('navigation, mute, interrupt, hands-free or nothing done → nothing', () => {
		for (const did of [
			[],
			['switch_view store-front/main'],
			['mute'],
			['interrupt crew/main'],
			['hands_free on'],
		]) {
			expect(summaryOf(did)).toBeUndefined();
		}
	});

	it('a failed entry, or a failed action → nothing', () => {
		expect(describeFor(withLog({ 'crew/main': [entry({ isFailed: true })] }))).toBeUndefined();
		expect(summaryOf(['debug_note "x" (failed)'])).toBeUndefined();
	});

	it('no back-reference → nothing', () => {
		expect(describeFor(withLog({ 'crew/main': [entry({})] }), 'Run the tests.')).toBeUndefined();
	});

	it('"edit" and "item" are not "it" → nothing', () => {
		expect(
			describeFor(withLog({ 'crew/main': [entry({})] }), 'Edit the item list.'),
		).toBeUndefined();
	});

	it('no words (typed or replayed) → nothing', () => {
		expect(
			describeRecentAction(withLog({ 'crew/main': [entry({})] }), {
				ref: 'crew/main',
				screen: 'crew/main',
				now: NOW,
				utterance: undefined,
			}),
		).toBeUndefined();
	});

	it('exactly 120 s old → the line; a moment older → nothing', () => {
		const at = (age: number) => withLog({ 'crew/main': [entry({ at: NOW - age })] });

		expect(describeFor(at(RECENT_ACTION_MS))).toBeDefined();
		expect(describeFor(at(RECENT_ACTION_MS + 1))).toBeUndefined();
	});

	it('the last action a forward or send_to to the same session → nothing: it already has it', () => {
		const forwarded = entry({ did: ['forward "Check the notes."'] });
		const sentTo = entry({ did: ['send_to crew/main "Check the notes."'] });

		expect(describeFor(withLog({ 'crew/main': [forwarded] }))).toBeUndefined();
		expect(describeFor(withLog({ [GRID]: [sentTo] }))).toBeUndefined();
	});

	it('the newest entry decides: a forward here after the note → nothing', () => {
		const forwarded = entry({ did: ['forward "Check the notes."'], at: NOW - 5_000 });

		expect(
			describeFor(withLog({ 'crew/main': [forwarded], [GRID]: [entry({ at: NOW - 8_000 })] })),
		).toBeUndefined();
	});

	it('the last words sent to another session → the line names where they went', () => {
		const elsewhere = entry({
			utterance: 'Tell checkout api to pin the retry count.',
			did: ['send_to checkout-api/main "Pin the retry count."'],
		});

		expect(describeFor(withLog({ 'crew/main': [elsewhere] }))).toBe(
			lineFor('Tell checkout api to pin the retry count.', 'sent it to checkout-api/main'),
		);
	});

	it('ignored words → skipped', () => {
		expect(describeFor(withLog({ 'crew/main': [entry({ isIgnored: true })] }))).toBeUndefined();
	});
});

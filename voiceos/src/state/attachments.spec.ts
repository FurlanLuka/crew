import { describe, expect, it } from 'bun:test';
import { MAX_ATTACHMENTS, type Attachment, type Input, type State } from '../shared/protocol.js';
import type { Effect } from './reducer.js';
import { describeCarried } from './attachments.js';
import { createFixtureState } from '../../test/support/state.js';
import { idleSession, REF, run, runningSession } from '../../test/support/reduce.js';

const file = (name: string): Attachment => ({
	id: `0123456789abcdef/${name}`,
	name,
	kind: 'file',
	bytes: 12,
});
const REPORT = file('report.pdf');
const SHOT: Attachment = { ...file('shot.png'), kind: 'image', mediaName: 'abc.png' };

const added = (attachment: Attachment, ref = REF): Input => ({
	type: 'attachment_added',
	ref,
	attachment,
});
const send = (text: string, patch: Partial<Extract<Input, { type: 'send' }>> = {}): Input => ({
	type: 'send',
	ref: REF,
	text,
	...patch,
});
const sendsOf = (effects: Effect[]) => effects.filter((effect) => effect.type === 'worker_send');
const waiting = (state: State, ref = REF) => state.attachments[ref];
const lastUserItem = (state: State) =>
	state.sessions[REF]?.stream.findLast((item) => item.kind === 'user');

const withFiles = (start: State, ...files: Attachment[]): State =>
	run(
		files.map((attachment) => added(attachment)),
		{ start },
	).state;

describe('attachments waiting on a session', () => {
	it('added once each, in order, never past the cap; an unknown session takes none', () => {
		const many = Array.from({ length: MAX_ATTACHMENTS + 2 }, (_, index) => file(`f${index}.txt`));
		const state = withFiles(idleSession(), REPORT, REPORT, ...many);

		expect(waiting(state)?.[0]).toEqual(REPORT);
		expect(waiting(state)).toHaveLength(MAX_ATTACHMENTS);
		expect(
			run([added(REPORT, 'nowhere/main')], { start: idleSession() }).state.attachments,
		).toEqual({});
	});

	it('the ✕ takes one off; the last one gone leaves no entry', () => {
		const start = withFiles(idleSession(), REPORT, SHOT);
		const one = run([{ type: 'attachment_removed', ref: REF, id: REPORT.id }], { start }).state;
		const none = run([{ type: 'attachment_removed', ref: REF, id: SHOT.id }], { start: one }).state;

		expect(waiting(one)).toEqual([SHOT]);
		expect(none.attachments).toEqual({});
	});
});

describe('the next words take them along', () => {
	it('idle: sent with the words, shown on the line, the chips cleared', () => {
		const { state, effects } = run([send('what is wrong here?')], {
			start: withFiles(idleSession(), REPORT, SHOT),
		});

		expect(sendsOf(effects)).toEqual([
			{
				type: 'worker_send',
				ref: REF,
				text: 'what is wrong here?',
				attachments: [REPORT, SHOT],
			},
		]);
		expect(lastUserItem(state)).toMatchObject({ attachments: [REPORT, SHOT] });
		expect(state.attachments).toEqual({});
	});

	it('no files: the send carries no attachments key at all', () => {
		const { effects } = run([send('hello')], { start: idleSession() });

		expect(sendsOf(effects)[0]).toEqual({ type: 'worker_send', ref: REF, text: 'hello' });
	});

	it('working: queued with the words, and sent with them when the turn ends', () => {
		const queued = run([send('and this one')], { start: withFiles(runningSession(), REPORT) });

		expect(queued.state.sessions[REF]?.queue[0]?.attachments).toEqual([REPORT]);
		expect(queued.state.attachments).toEqual({});

		const ended = run([{ type: 'turn_ended', ref: REF, costUsd: 0, text: 'Done.' }], {
			start: queued.state,
		});

		expect(sendsOf(ended.effects)[0]).toMatchObject({ attachments: [REPORT] });
	});

	it('words that would go aside go queued when they carry files: the fork cannot open them', () => {
		const start = withFiles(runningSession(), SHOT);
		const { state, effects } = run([send('which file is this?', { aside: true })], { start });

		expect(effects.some((effect) => effect.type === 'side_answer')).toBe(false);
		expect(state.sessions[REF]?.queue[0]).toMatchObject({
			text: 'which file is this?',
			attachments: [SHOT],
		});
	});

	it('the same words without files still go aside', () => {
		const { effects } = run([send('which file is this?', { aside: true })], {
			start: runningSession(),
		});

		expect(effects.some((effect) => effect.type === 'side_answer')).toBe(true);
	});

	it('typed words queued behind others, then all promoted, carry both their files once each', () => {
		const first = run([send('first')], { start: withFiles(runningSession(), REPORT) }).state;
		const second = run([added(SHOT), added(REPORT), send('second')], { start: first }).state;
		const { state } = run([{ type: 'promote_all_queued', ref: REF }], { start: second });

		expect(state.sessions[REF]?.queue).toHaveLength(1);
		expect(state.sessions[REF]?.queue[0]?.attachments).toEqual([REPORT, SHOT]);
	});

	it('another session keeps its own', () => {
		const start = run(
			[{ type: 'activate', ref: 'store/wrk1' }, added(REPORT), added(SHOT, 'store/wrk1')],
			{ start: idleSession() },
		).state;
		const { state } = run([send('look')], { start });

		expect(waiting(state, 'store/wrk1')).toEqual([SHOT]);
		expect(waiting(state)).toBeUndefined();
	});

	it('an inactive session holds the words and their files until it is activated', () => {
		const start = withFiles(
			run([{ type: 'deactivate', ref: REF }], { start: idleSession() }).state,
			REPORT,
		);
		const held = run([send('look at this')], { start }).state;

		expect(held.sessions[REF]?.queue[0]?.attachments).toEqual([REPORT]);

		const activated = run(
			[
				{ type: 'activate', ref: REF },
				{ type: 'session_started', ref: REF },
			],
			{ start: held },
		);

		expect(sendsOf(activated.effects)[0]).toMatchObject({ attachments: [REPORT] });
	});
});

describe('words that never went give their files back', () => {
	it('cancelled from the queue: waiting again, ahead of newer ones', () => {
		const queued = run([send('this')], { start: withFiles(runningSession(), REPORT) }).state;
		const id = queued.sessions[REF]?.queue[0]?.id ?? '';
		const { state } = run([added(SHOT), { type: 'cancel_queued', ref: REF, queuedId: id }], {
			start: queued,
		});

		expect(waiting(state)).toEqual([REPORT, SHOT]);
	});

	it('taken back by voice: waiting again', () => {
		const queued = run([send('this')], { start: withFiles(runningSession(), REPORT) }).state;
		const id = queued.sessions[REF]?.queue[0]?.id ?? '';
		const { state } = run([{ type: 'take_back', ref: REF, id }], { start: queued });

		expect(waiting(state)).toEqual([REPORT]);
	});

	it("removing a machine drops its sessions' files", () => {
		const ref = 'personal:crew/main';
		const start = run([added(REPORT, ref)], {
			start: createFixtureState({ machine: { id: 'personal', name: 'Personal', refs: [ref] } }),
		}).state;

		expect(waiting(start, ref)).toEqual([REPORT]);
		expect(
			run([{ type: 'remove_machine', id: 'other' }], { start }).state.attachments[ref],
		).toEqual([REPORT]);
		expect(
			run([{ type: 'remove_machine', id: 'personal' }], { start }).state.attachments[ref],
		).toBeUndefined();
	});
});

describe('words sent from elsewhere', () => {
	it('"Sent to … with 2 files." when the files went with them', () => {
		const start = run([{ type: 'switch_view', view: { kind: 'session', ref: 'store/wrk1' } }], {
			start: withFiles(idleSession(), REPORT, SHOT),
		}).state;
		const { effects } = run([send('look', { ack: { kind: 'instruction' } })], { start });
		const spoken = effects.flatMap((effect) => (effect.type === 'speak' ? [effect.text] : []));

		expect(spoken.some((text) => text.includes('with 2 files'))).toBe(true);
	});
});

describe('a deactivated session', () => {
	it('keeps its files: the page attaches to inactive sessions too', () => {
		const start = withFiles(idleSession(), REPORT);
		const { state } = run([{ type: 'deactivate', ref: REF }], { start });

		expect(waiting(state)).toEqual([REPORT]);
	});
});

describe('the other ways words reach a working session', () => {
	const redirect = (patch: Partial<Extract<Input, { type: 'send' }>> = {}): Input =>
		send('Stop that and fix the login first.', {
			isSpoken: true,
			ack: { kind: 'redirect' },
			...patch,
		});
	const askOf = (state: State) => state.asks.find((ask) => ask.kind === 'redirect');
	const heldWithFile = () =>
		run([redirect()], { start: withFiles(runningSession(), REPORT) }).state;

	it('a redirect held for a yes keeps its files in the question', () => {
		const state = heldWithFile();

		expect(askOf(state)).toMatchObject({ attachments: [REPORT] });
		expect(state.attachments).toEqual({});
	});

	it.each<[string, (state: State) => Input]>([
		[
			'yes',
			(state) => ({ type: 'answer_redirect', askId: askOf(state)?.id ?? '', isApproved: true }),
		],
		[
			'no',
			(state) => ({ type: 'answer_redirect', askId: askOf(state)?.id ?? '', isApproved: false }),
		],
		['no answer in time', (state) => ({ type: 'command_expired', askId: askOf(state)?.id ?? '' })],
	])('the redirect answered %s → its words queued with their files', (_, answer) => {
		const state = heldWithFile();
		const after = run([answer(state)], { start: state }).state;

		expect(after.sessions[REF]?.queue[0]?.attachments).toEqual([REPORT]);
	});

	it('other words while the redirect waits → it goes after with its files, the new words with theirs', () => {
		const state = run(
			[added(SHOT), send('also run the linter', { ack: { kind: 'instruction' } })],
			{
				start: heldWithFile(),
			},
		).state;

		expect(state.sessions[REF]?.queue.map((message) => message.attachments)).toEqual([
			[REPORT],
			[SHOT],
		]);
	});

	it('the held redirect taken back → its files wait again', () => {
		const state = heldWithFile();
		const after = run([{ type: 'take_back', ref: REF, id: askOf(state)?.id ?? '' }], {
			start: state,
		}).state;

		expect(waiting(after)).toEqual([REPORT]);
	});

	it('a spoken follow-up that cuts the turn → the cut words already had their files, the rest goes with its own', () => {
		const spoken = run([send('look at the logs', { isSpoken: true })], {
			start: withFiles(idleSession(), REPORT),
		});
		const { state, effects } = run([added(SHOT), send('and this screenshot', { isSpoken: true })], {
			start: spoken.state,
		});

		expect(sendsOf(spoken.effects)[0]?.attachments).toEqual([REPORT]);
		expect(effects).toContainEqual({ type: 'worker_interrupt', ref: REF, reason: 'follow-up' });
		expect(state.sessions[REF]?.queue[0]?.attachments).toEqual([SHOT]);
	});

	it('spoken words queued behind typed work, then more → each message with its own files', () => {
		const first = run([send('look at the logs', { isSpoken: true })], {
			start: withFiles(runningSession(), REPORT),
		}).state;
		const { state } = run([added(SHOT), send('and this screenshot', { isSpoken: true })], {
			start: first,
		});

		expect(state.sessions[REF]?.queue.map((message) => message.attachments)).toEqual([
			[REPORT],
			[SHOT],
		]);
	});

	it('"send it now" → the words that cut the work carry the files', () => {
		const { state } = run([send('use the staging table', { isNow: true })], {
			start: withFiles(runningSession(), REPORT),
		});

		expect(state.sessions[REF]?.queue[0]?.attachments).toEqual([REPORT]);
	});

	it('words that answer its open question → the answer goes alone, the files keep waiting', () => {
		const start = run(
			[
				{
					type: 'ask_opened',
					ask: {
						id: 'q1',
						ref: REF,
						at: 1,
						kind: 'question',
						input: {},
						questions: [
							{
								question: 'Which table?',
								header: 'Table',
								options: [{ label: 'staging' }, { label: 'prod' }],
								multiSelect: false,
							},
						],
					},
				},
			],
			{ start: withFiles(runningSession(), REPORT) },
		).state;
		const { state } = run([send('staging')], { start });

		expect(waiting(state)).toEqual([REPORT]);
	});
});

describe('describeCarried', () => {
	it.each<[Attachment[] | undefined, string]>([
		[undefined, ''],
		[[], ''],
		[[REPORT], ' with a file'],
		[[REPORT, SHOT], ' with 2 files'],
	])('%p → %p', (attachments, line) => expect(describeCarried(attachments)).toBe(line));
});

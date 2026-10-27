import { describe, expect, it } from 'bun:test';
import type { PendingAsk, Session, State } from '../shared/protocol.js';
import { createInitialState, createSession } from '../state/reducer.js';
import { describePhoneCard } from './phone-home.js';

const NOW = 1_000_000;
const STORE = 'store-front/main';
const REMOTE = 'vm1:store-api/main';

const session = (ref: string, patch: Partial<Session> = {}): Session => ({
	...createSession({ ref, label: ref, branch: 'b', cwd: '/w', dirs: [], isPinned: false }),
	...patch,
});

const stateWith = (sessions: Session[], asks: PendingAsk[] = []): State => ({
	...createInitialState(),
	sessions: Object.fromEntries(sessions.map((item) => [item.ref, item])),
	order: sessions.map((item) => item.ref),
	active: sessions.map((item) => item.ref),
	asks,
	machines: {
		vm1: {
			id: 'vm1',
			host: 'dev@vm1',
			name: 'Build box',
			status: 'connected',
			detail: null,
			since: 1,
		},
	},
});

describe('describePhoneCard', () => {
	it('waiting with a question: what it asks, as the one line', () => {
		const card = describePhoneCard(
			stateWith(
				[session(STORE, { status: 'blocked' })],
				[
					{
						id: 'a1',
						ref: STORE,
						at: 1,
						kind: 'question',
						input: {},
						questions: [
							{
								question: 'A Redis queue or a jobs table?',
								multiSelect: false,
								options: [{ label: 'Redis' }],
							},
						],
					},
				],
			),
			STORE,
			NOW,
		);

		expect(card).toEqual({
			dot: 'blocked',
			title: STORE,
			line: 'Asks: A Redis queue or a jobs table?',
			isWaiting: true,
		});
	});

	it('waiting on a permission: what it wants to do', () => {
		const card = describePhoneCard(
			stateWith(
				[session(STORE, { status: 'blocked' })],
				[
					{
						id: 'a2',
						ref: STORE,
						at: 1,
						kind: 'permission',
						toolName: 'Bash',
						summary: 'run git push',
						input: {},
						suggestions: [],
					},
				],
			),
			STORE,
			NOW,
		);

		expect(card?.line).toBe('Permission: run git push');
		expect(card?.isWaiting).toBe(true);
	});

	it('working: for how long', () => {
		const card = describePhoneCard(
			stateWith([
				session(STORE, {
					status: 'running',
					requests: [{ text: 'add the search box', at: NOW - 120_000 }],
				}),
			]),
			STORE,
			NOW,
		);

		expect(card).toMatchObject({ dot: 'running', line: 'Working · 2m', isWaiting: false });
	});

	it('starting reads Starting, not Working', () =>
		expect(
			describePhoneCard(stateWith([session(STORE, { status: 'starting' })]), STORE, NOW)?.line,
		).toBe('Starting'));

	it('a question and a permission open at once: the line names the permission, as the dot does', () => {
		const card = describePhoneCard(
			stateWith(
				[session(STORE, { status: 'blocked' })],
				[
					{
						id: 'q',
						ref: STORE,
						at: 1,
						kind: 'question',
						input: {},
						questions: [{ question: 'Which?', multiSelect: false, options: [{ label: 'A' }] }],
					},
					{
						id: 'p',
						ref: STORE,
						at: 2,
						kind: 'permission',
						toolName: 'Bash',
						summary: 'run git push',
						input: {},
						suggestions: [],
					},
				],
			),
			STORE,
			NOW,
		);

		expect(card?.line).toBe('Permission: run git push');
	});

	it('idle, not started and crashed', () => {
		expect(
			describePhoneCard(stateWith([session(STORE, { status: 'idle' })]), STORE, NOW)?.line,
		).toBe('Ready');
		expect(describePhoneCard(stateWith([session(STORE)]), STORE, NOW)?.line).toBe('Idle');
		expect(
			describePhoneCard(stateWith([session(STORE, { error: 'exit 1' })]), STORE, NOW)?.line,
		).toBe('Crashed');
	});

	it('another machine is named; this Mac goes without saying', () => {
		const state = stateWith([
			session(STORE, { status: 'idle' }),
			session(REMOTE, { status: 'idle' }),
		]);

		expect(describePhoneCard(state, REMOTE, NOW)?.machine).toBe('Build box');
		expect(describePhoneCard(state, STORE, NOW)).not.toHaveProperty('machine');
	});

	it('a session not listed has no card', () =>
		expect(describePhoneCard(stateWith([]), STORE, NOW)).toBeNull());
});

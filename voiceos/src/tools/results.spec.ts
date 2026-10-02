import { describe, expect, it } from 'bun:test';
import type { State } from '../shared/protocol.js';
import { createInitialState, createSession } from '../state/reducer.js';
import { type RefCheck, checkRef } from './results.js';

const REFS = ['setup', 'store-front/main', 'store-front/wrk1', 'vm1:setup', 'vm1:store-front/main'];

const createState = (patch: Partial<State> = {}): State => ({
	...createInitialState(),
	sessions: Object.fromEntries(
		REFS.map((ref) => [
			ref,
			createSession({
				ref,
				label: ref.replace(/^vm1:/, ''),
				branch: '',
				cwd: '/w',
				dirs: [],
				isPinned: ref.endsWith('setup'),
			}),
		]),
	),
	order: REFS,
	machines: {
		vm1: {
			id: 'vm1',
			host: 'dev@vm1',
			name: 'Build box',
			status: 'connected',
			detail: null,
			since: 0,
		},
	},
	active: ['store-front/main'],
	...patch,
});

describe('checkRef', () => {
	it('an active session, by ref or as said → that ref', () => {
		expect(checkRef(createState(), 'store-front/main')).toEqual({
			ok: true,
			ref: 'store-front/main',
		});
		expect(checkRef(createState(), 'store front main')).toEqual({
			ok: true,
			ref: 'store-front/main',
		});
	});

	it('an inactive session, by ref or as said → the inactive variant, for "Activate it?"', () => {
		const inactive: RefCheck = {
			ok: false,
			error: 'store-front/wrk1 is not active',
			inactive: 'store-front/wrk1',
		};

		expect(checkRef(createState(), 'store-front/wrk1')).toEqual(inactive);
		expect(checkRef(createState(), 'work one')).toEqual(inactive);
	});

	it('"setup", by name or by ref, here or on vm1 → never reached: setup lives in Set up', () => {
		const views = [{ kind: 'activate', machine: 'vm1' }, { kind: 'activate' }, { kind: 'active' }];

		for (const view of views) {
			const state = createState({ view: view as State['view'], active: ['vm1:setup', 'setup'] });

			for (const said of ['setup', 'vm1:setup', 'setup session']) {
				expect(checkRef(state, said)).toMatchObject({ ok: false });
				expect(checkRef(state, said)).not.toHaveProperty('inactive');
			}
		}
	});

	it('a name active on another machine and inactive here → the active one', () => {
		const state = createState({
			view: { kind: 'activate', machine: 'local' },
			active: ['vm1:store-front/main'],
		});

		expect(checkRef(state, 'store front main')).toEqual({
			ok: true,
			ref: 'vm1:store-front/main',
		});
	});

	it('nothing answers → fails, listing only the active sessions', () => {
		expect(checkRef(createState(), 'billing main')).toEqual({
			ok: false,
			error:
				'no active session "billing main". Active sessions: store-front/main. Another worktree is reached with activate.',
		});
	});

	it('nothing answers and nothing is active → says none is, never an empty list', () => {
		expect(checkRef(createState({ active: [] }), 'billing main')).toEqual({
			ok: false,
			error:
				'no active session "billing main". No sessions are active. Another worktree is reached with activate.',
		});
	});

	it('no ref → missing', () => {
		expect(checkRef(createState(), '')).toEqual({ ok: false, error: 'missing ref' });
	});
});

import { describe, expect, it } from 'bun:test';
import type { PendingAsk, State, WorktreeInfo } from '../shared/protocol.js';
import { createInitialState, createSession } from '../state/reducer.js';
import { findRefsByName, resolveRef, resolveTypedTarget, writeSpokenRefs } from './refs.js';

const createWorktreeInfo = (ref: string, isPinned = false): WorktreeInfo => ({
	ref,
	label: ref,
	branch: '',
	cwd: '/w',
	dirs: [],
	isPinned,
});

const createState = (patch: Partial<State> = {}): State => {
	const refs = ['store-front/main', 'store-front/wrk1', 'checkout-api/main', 'setup'];
	const sessions = Object.fromEntries(
		refs.map((ref) => [
			ref,
			{ ...createSession(createWorktreeInfo(ref, ref === 'setup')), status: 'idle' as const },
		]),
	);

	// Every session active unless the test says otherwise: this Mac's setup always is.
	return {
		...createInitialState(),
		sessions,
		order: refs,
		active: refs.filter((ref) => ref !== 'setup'),
		...patch,
	};
};

const createViewingState = (ref: string, patch: Partial<State> = {}) =>
	createState({ view: { kind: 'session', ref }, focus: ref, ...patch });

const permission: PendingAsk = {
	id: 'p1',
	ref: 'store-front/wrk1',
	at: 1,
	kind: 'permission',
	toolName: 'Bash',
	summary: 'run git push',
	input: {},
	suggestions: [],
};

const createQuestion = (multiSelect = false): PendingAsk => ({
	id: 'q1',
	ref: 'store-front/main',
	at: 1,
	kind: 'question',
	input: {},
	questions: [
		{
			question: 'Where should events go?',
			multiSelect,
			options: [{ label: 'New table' }, { label: 'Reuse orders' }, { label: 'Defer' }],
		},
	],
});

describe('resolveRef', () => {
	it('full ref, worktree name, spoken digits', () => {
		const state = createState({ focus: 'store-front/main' });

		expect(resolveRef(state, 'store-front/wrk1')).toBe('store-front/wrk1');
		expect(resolveRef(state, 'wrk1')).toBe('store-front/wrk1');
		expect(resolveRef(state, 'work one')).toBe('store-front/wrk1');
	});

	it('"main" is ambiguous → the focused workspace decides', () => {
		expect(resolveRef(createState(), 'main')).toBeNull();
		expect(resolveRef(createState({ focus: 'checkout-api/main' }), 'main')).toBe(
			'checkout-api/main',
		);
	});

	it('unknown name → null (left to the kernel)', () => {
		expect(resolveRef(createState(), 'the ranking work')).toBeNull();
	});

	it('an inactive session → not reached by default; reached when every session is a candidate', () => {
		const state = createState({ active: ['store-front/main'] });

		expect(resolveRef(state, 'work one')).toBeNull();
		expect(resolveRef(state, 'work one', state.order)).toBe('store-front/wrk1');
	});

	it('"main" with only one main active → that one, no focus needed', () => {
		expect(resolveRef(createState({ active: ['checkout-api/main'] }), 'main')).toBe(
			'checkout-api/main',
		);
	});

	it('a setup session → never reached by name, even among every session: it lives in Set up', () => {
		const state = createState({ active: ['setup'] });

		for (const said of ['setup', 'setup session', 'the setup']) {
			expect(resolveRef(state, said)).toBeNull();
			expect(resolveRef(state, said, state.order)).toBeNull();
		}

		expect(findRefsByName(state, 'setup', state.order)).toEqual([]);
	});
});

describe('findRefsByName', () => {
	it('every candidate answering to the name, none outside the candidates', () => {
		const state = createState();

		expect(findRefsByName(state, 'main', state.order)).toEqual([
			'store-front/main',
			'checkout-api/main',
		]);
		expect(findRefsByName(state, 'the store front main session', ['store-front/wrk1'])).toEqual([]);
		expect(findRefsByName(state, '', state.order)).toEqual([]);
	});
});

describe('writeSpokenRefs', () => {
	const refs = [
		'setup',
		'signals/main',
		'signals/wrk1',
		'store-front/main',
		'store-front/wrk2',
		'crew/main',
	];
	const writeRefs = (text: string) => writeSpokenRefs({ text, refs });

	it('a transcript corpus → refs written as the developer sees them elsewhere', () => {
		expect(
			[
				'Can you open signals work 1?',
				'Can you open signals work one?',
				'open signals slash wrk1',
				'Signals, work 1',
				'store front main, run the tests',
				'Crew slash main is now on screen',
				'store-front main and store front work two',
			].map(writeRefs),
		).toEqual([
			'Can you open signals/wrk1?',
			'Can you open signals/wrk1?',
			'open signals/wrk1',
			'signals/wrk1',
			'store-front/main, run the tests',
			'crew/main is now on screen',
			'store-front/main and store-front/wrk2',
		]);
	});

	it('a lone worktree name, a word containing a name, or a ref already written → unchanged', () => {
		for (const text of [
			'the main thing',
			'signalswork 1',
			'already signals/wrk1 here',
			'make it mainstream',
		]) {
			expect(writeRefs(text)).toBe(text);
		}
	});

	it('the same name on another machine → written without the machine', () => {
		for (const machineRefs of [
			['speak/main', 'personal:speak/main'],
			['personal:speak/main', 'speak/main'],
			['personal:speak/main'],
		]) {
			expect(writeSpokenRefs({ text: 'Can you switch to speak main?', refs: machineRefs })).toBe(
				'Can you switch to speak/main?',
			);
		}
	});

	it('no refs → unchanged', () => {
		expect(writeSpokenRefs({ text: 'signals work 1', refs: [] })).toBe('signals work 1');
	});
});

describe('resolveTypedTarget', () => {
	it('typed on a session screen → that session', () => {
		expect(resolveTypedTarget(createViewingState('store-front/main'), 'run the tests')).toBe(
			'store-front/main',
		);
	});

	it('"Voice OS, …" typed into a session\'s box → the kernel, never that session', () => {
		expect(
			resolveTypedTarget(createViewingState('store-front/main'), 'Voice OS, activate billing.'),
		).toBeNull();
	});

	it('on Mission Control → nothing (the kernel decides)', () => {
		expect(resolveTypedTarget(createState(), 'run the tests')).toBeNull();
	});

	it('that session waits on a permission or a question → the kernel answers it', () => {
		const permissionState = createViewingState('store-front/wrk1', { asks: [permission] });
		const questionState = createViewingState('store-front/main', { asks: [createQuestion()] });

		expect(resolveTypedTarget(permissionState, 'yes')).toBeNull();
		expect(resolveTypedTarget(questionState, 'the second one')).toBeNull();
	});

	it("another session's ask does not stop typing into this one", () => {
		const state = createViewingState('store-front/main', { asks: [permission] });

		expect(resolveTypedTarget(state, 'run the tests')).toBe('store-front/main');
	});

	it('addressed to an inactive session by name → the kernel, which asks to activate it', () => {
		const state = createViewingState('store-front/main', { active: ['store-front/main'] });

		expect(resolveTypedTarget(state, 'wrk1: run the tests')).toBeNull();
	});

	it('addressed to another session by name, with a comma or a colon → the kernel', () => {
		const state = createViewingState('store-front/main');

		expect(resolveTypedTarget(state, 'checkout-api/main, run the tests')).toBeNull();
		expect(resolveTypedTarget(state, 'wrk1: run the tests')).toBeNull();
	});

	it('addressed to this session, or a comma that names nobody → this session', () => {
		const state = createViewingState('store-front/main');

		expect(resolveTypedTarget(state, 'store-front/main, run the tests')).toBe('store-front/main');
		expect(resolveTypedTarget(state, 'well, run the tests')).toBe('store-front/main');
	});

	it('the view points at a session that is gone → nothing', () => {
		const state = createState({ view: { kind: 'session', ref: 'gone/main' } });

		expect(resolveTypedTarget(state, 'hi')).toBeNull();
	});
});

describe('resolveRef across machines', () => {
	const machineState = (view: State['view']): State => {
		const refs = ['store-front/main', 'vm1:store-front/main', 'vm1:setup'];
		const sessions = Object.fromEntries(
			refs.map((ref) => [
				ref,
				{
					...createSession({
						...createWorktreeInfo(ref, ref.endsWith('setup')),
						label: ref.replace(/^vm1:/, ''),
					}),
					status: 'idle' as const,
				},
			]),
		);

		return {
			...createInitialState(),
			sessions,
			order: refs,
			active: refs,
			view,
			machines: {
				vm1: {
					id: 'vm1',
					host: 'vm1',
					name: 'Build box',
					status: 'connected',
					detail: null,
					since: 0,
				},
			},
		};
	};

	it("the machine named in front → that machine's session", () => {
		expect(resolveRef(machineState({ kind: 'active' }), 'build box store front main')).toBe(
			'vm1:store-front/main',
		);
		expect(resolveRef(machineState({ kind: 'active' }), 'build box setup')).toBeNull();
	});

	it('the same name on two machines → the one the developer is in', () => {
		expect(resolveRef(machineState({ kind: 'activate', machine: 'vm1' }), 'store front main')).toBe(
			'vm1:store-front/main',
		);
		expect(
			resolveRef(machineState({ kind: 'activate', machine: 'local' }), 'store front main'),
		).toBe('store-front/main');
	});

	it('the same name on two machines, looking at all → nobody guessed', () => {
		expect(resolveRef(machineState({ kind: 'active' }), 'store front main')).toBeNull();
	});
});

describe('resolveRef by a name the developer gave', () => {
	const named = (view: State['view']): State => {
		const state = createState({ view });

		return { ...state, names: { 'store-front/wrk1': 'voice os dev' } };
	};

	it('the name, however it is spelled or said → that session, from anywhere', () => {
		for (const phrase of ['voice os dev', 'Voice-OS dev', 'the voice os dev session']) {
			expect(resolveRef(named({ kind: 'active' }), phrase)).toBe('store-front/wrk1');
		}
	});

	it('the crew words → still that session', () => {
		expect(resolveRef(named({ kind: 'active' }), 'store front work one')).toBe('store-front/wrk1');
	});

	it('the name gone → no longer resolves', () => {
		expect(resolveRef(createState({ view: { kind: 'active' } }), 'voice os dev')).toBeNull();
	});
});

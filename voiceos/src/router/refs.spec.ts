import { describe, expect, it } from 'bun:test';
import type { PendingAsk, State, WorktreeInfo } from '../shared/protocol.js';
import { createInitialState, createSession } from '../state/reducer.js';
import { resolveRef, resolveTypedTarget, writeSpokenRefs } from './refs.js';

const createWorktreeInfo = (ref: string, isPinned = false): WorktreeInfo => ({
	ref,
	label: ref,
	branch: '',
	cwd: '/w',
	dirs: [],
	isPinned,
});

const createState = (patch: Partial<State> = {}): State => {
	const refs = ['store-front/main', 'store-front/wrk1', 'checkout-api/main', 'voiceos'];
	const sessions = Object.fromEntries(
		refs.map((ref) => [
			ref,
			{ ...createSession(createWorktreeInfo(ref, ref === 'voiceos')), status: 'idle' as const },
		]),
	);

	return { ...createInitialState(), sessions, order: refs, ...patch };
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
		expect(resolveRef(state, 'voice os')).toBe('voiceos');
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
});

describe('writeSpokenRefs', () => {
	const refs = [
		'voiceos',
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

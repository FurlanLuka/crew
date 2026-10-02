import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import type { Machine, State } from './protocol.js';
import { createInitialState, createSession } from '../state/reducer.js';
import {
	currentMachine,
	describeMachineWaiting,
	describeRecap,
	isRecapNews,
	diffMachines,
	HOME_VIEW,
	isKnownMachineRef,
	isReachable,
	isValidHost,
	listWaitingRefs,
	machineIdFor,
	parentView,
	readElsewhereMachine,
} from './machines.js';

const machine = (id: string, patch: Partial<Machine> = {}): Machine => ({
	id,
	host: id,
	name: id,
	status: 'connected',
	detail: null,
	since: 0,
	...patch,
});

const withSessions = (refs: string[], patch: Partial<State> = {}): State => ({
	...createInitialState(),
	sessions: Object.fromEntries(
		refs.map((ref) => [
			ref,
			createSession({
				ref,
				label: ref.replace(/^[^:]*:/, ''),
				branch: '',
				cwd: '/w',
				dirs: [],
				isPinned: false,
			}),
		]),
	),
	order: refs,
	...patch,
});

// One table for both sides: crew's Go (crew server machines) reads it too.
const MACHINE_IDS: { host: string; taken: string[]; id: string }[] = JSON.parse(
	readFileSync(
		join(import.meta.dir, '../../../crew/internal/voice/testdata/machine-ids.json'),
		'utf8',
	),
);

describe('machineIdFor', () => {
	it.each(MACHINE_IDS.map((row) => [row.host, row] as const))(
		'%s → the id crew gives it too',
		(_host, row) => {
			expect(machineIdFor(row.host, row.taken)).toBe(row.id);
		},
	);
});

describe('isValidHost', () => {
	it('aliases and user@host pass', () => {
		expect(isValidHost('vm1')).toBe(true);
		expect(isValidHost('dev@vm1.example.com')).toBe(true);
	});

	it('anything ssh could read as an option, or a shell word, is refused', () => {
		expect(isValidHost('-oProxyCommand=touch')).toBe(false);
		expect(isValidHost('vm1; rm -rf')).toBe(false);
		expect(isValidHost('')).toBe(false);
	});
});

describe('diffMachines', () => {
	const vm1 = { id: 'vm1', host: 'vm1', name: 'vm1' };

	it('added → started; removed → stopped', () => {
		expect(diffMachines([], [vm1])).toEqual({ start: [vm1], stop: [] });
		expect(diffMachines([vm1], [])).toEqual({ start: [], stop: ['vm1'] });
	});

	it('renamed → neither: the link stays up', () => {
		expect(diffMachines([vm1], [{ ...vm1, name: 'Build box' }])).toEqual({ start: [], stop: [] });
	});

	it('another host under the same id → restarted', () => {
		const moved = { ...vm1, host: 'dev@vm1.example.com' };

		expect(diffMachines([vm1], [moved])).toEqual({ start: [moved], stop: ['vm1'] });
	});
});

describe('readElsewhereMachine', () => {
	const remote = 'vm1:crew/main';
	const base = withSessions(['crew/main', remote], {
		machines: { vm1: machine('vm1', { name: 'Personal' }) },
	});

	it('a local session → null', () => expect(readElsewhereMachine(base, 'crew/main')).toBeNull());
	it('a remote session, the developer inside that machine → null', () =>
		expect(
			readElsewhereMachine({ ...base, view: { kind: 'activate', machine: 'vm1' } }, remote),
		).toBeNull());
	it('a remote session the developer named → null', () =>
		expect(
			readElsewhereMachine({ ...base, names: { [remote]: 'voice os dev' } }, remote),
		).toBeNull());
	it('a remote unnamed session seen from elsewhere → its machine name', () =>
		expect(readElsewhereMachine(base, remote)).toBe('Personal'));
	it('a machine the state does not know → null', () =>
		expect(readElsewhereMachine(base, 'gpu:crew/main')).toBeNull());
});

describe('isKnownMachineRef', () => {
	const state = withSessions([], { machines: { vm1: machine('vm1') } });

	it('this Mac or a known machine → true; an unknown machine → false', () => {
		expect(isKnownMachineRef(state, 'crew/main')).toBe(true);
		expect(isKnownMachineRef(state, 'vm1:crew/main')).toBe(true);
		expect(isKnownMachineRef(state, 'gpu:crew/main')).toBe(false);
	});
});

describe('isReachable', () => {
	it('this Mac always; another machine only when connected', () => {
		const state = withSessions([], { machines: { vm1: machine('vm1', { status: 'syncing' }) } });

		expect(isReachable(state, 'store/main')).toBe(true);
		expect(isReachable(state, 'vm1:store/main')).toBe(false);
		expect(isReachable({ ...state, machines: { vm1: machine('vm1') } }, 'vm1:store/main')).toBe(
			true,
		);
	});

	it('a machine that is gone → not reachable', () => {
		expect(isReachable(withSessions([]), 'vm9:store/main')).toBe(false);
	});
});

describe('views', () => {
	const state = withSessions(['store/main', 'vm1:store/main'], {
		machines: { vm1: machine('vm1') },
	});

	it('home → Active; up from Activate or Settings → home', () => {
		expect(HOME_VIEW).toEqual({ kind: 'active' });
		expect(
			parentView({ ...withSessions([]), view: { kind: 'activate', machine: 'local' } }),
		).toEqual(HOME_VIEW);
		expect(parentView({ ...withSessions([]), view: { kind: 'settings' } })).toEqual(HOME_VIEW);
	});

	it('up from a session not opened from Active → its machine on Activate, this Mac included', () => {
		const inSession: State = { ...state, view: { kind: 'session', ref: 'vm1:store/main' } };
		const local: State = {
			...withSessions(['store/main']),
			view: { kind: 'session', ref: 'store/main' },
		};

		expect(parentView(inSession)).toEqual({ kind: 'activate', machine: 'vm1' });
		expect(parentView(local)).toEqual({ kind: 'activate', machine: 'local' });
	});

	it('up from a session opened from Active → Active → home', () => {
		const fromActive: State = {
			...state,
			view: { kind: 'session', ref: 'vm1:store/main', from: 'active' },
		};

		expect(parentView(fromActive)).toEqual({ kind: 'active' });
		expect(parentView({ ...state, view: { kind: 'active' } })).toEqual(HOME_VIEW);
	});

	it("currentMachine → the session's machine, or Activate's filter; none on views of all", () => {
		expect(currentMachine({ ...state, view: { kind: 'session', ref: 'store/main' } })).toBe(
			'local',
		);
		expect(currentMachine({ ...state, view: { kind: 'activate', machine: 'vm1' } })).toBe('vm1');
		expect(currentMachine({ ...state, view: { kind: 'active' } })).toBeNull();
		expect(currentMachine({ ...state, view: { kind: 'activate' } })).toBeNull();
		expect(currentMachine({ ...state, view: { kind: 'settings' } })).toBeNull();
	});
});

describe('listWaitingRefs', () => {
	const base = withSessions(['store/main', 'store/wrk1', 'vm1:store/main'], {
		machines: { vm1: machine('vm1') },
	});
	const state: State = {
		...base,
		asks: [
			{ id: 'a', ref: 'vm1:store/main', at: 1, kind: 'plan', input: {}, plan: 'p' },
			{ id: 'b', ref: 'vm1:store/main', at: 1, kind: 'plan', input: {}, plan: 'q' },
		],
		sessions: {
			...base.sessions,
			'store/wrk1': { ...base.sessions['store/wrk1']!, needsUser: { text: 'which one?', at: 1 } },
		},
	};

	it('asks and a "needs you" line, each session once, in session order', () => {
		expect(listWaitingRefs(state)).toEqual(['store/wrk1', 'vm1:store/main']);
	});

	it("a setup session's ask or question → not waiting on voice: Set up's chat shows it", () => {
		const withSetup = withSessions(['setup', 'store/main', 'vm1:setup'], {
			machines: { vm1: machine('vm1') },
		});
		const asking: State = {
			...withSetup,
			asks: [{ id: 's', ref: 'setup', at: 1, kind: 'plan', input: {}, plan: 'p' }],
			sessions: {
				...withSetup.sessions,
				'vm1:setup': { ...withSetup.sessions['vm1:setup']!, needsUser: { text: 'which?', at: 1 } },
			},
		};

		expect(listWaitingRefs(asking)).toEqual([]);
	});

	it('one machine → only its sessions', () => {
		expect(listWaitingRefs(state, 'vm1')).toEqual(['vm1:store/main']);
		expect(listWaitingRefs(state, 'local')).toEqual(['store/wrk1']);
	});

	it('describeMachineWaiting names them, or says nothing when nothing waits', () => {
		expect(describeMachineWaiting(state, 'vm1')).toBe('vm1. store/main is waiting on you.');
		expect(describeMachineWaiting({ ...state, asks: [] }, 'vm1')).toBe('');
	});
});

describe('describeRecap', () => {
	it('what finished, then what waits', () => {
		expect(
			describeRecap({ name: 'Build box', finished: ['store/wrk2'], waiting: ['store/wrk3'] }),
		).toBe('Build box is back: store/wrk2 finished, store/wrk3 is waiting on you.');
	});

	it('several → joined with and', () => {
		expect(describeRecap({ name: 'Build box', finished: ['a', 'b', 'c'], waiting: [] })).toBe(
			'Build box is back: a, b and c finished.',
		);
	});

	it('nothing happened → only that it is back', () => {
		expect(describeRecap({ name: 'Build box', finished: [], waiting: [] })).toBe(
			'Build box is back.',
		);
	});
});

describe('isRecapNews', () => {
	it('nothing finished, nothing waiting → no news (the page shows it is back)', () => {
		expect(isRecapNews({ finished: [], waiting: [], waitingSaid: [] })).toBe(false);
	});

	it('the same sessions still waiting as at the last connect → no news', () => {
		expect(isRecapNews({ finished: [], waiting: ['checkout'], waitingSaid: ['checkout'] })).toBe(
			false,
		);
	});

	it('a turn finished, or a session newly waiting → news', () => {
		expect(isRecapNews({ finished: ['store'], waiting: [], waitingSaid: [] })).toBe(true);
		expect(
			isRecapNews({ finished: [], waiting: ['checkout', 'signals'], waitingSaid: ['checkout'] }),
		).toBe(true);
	});

	it('fewer sessions waiting than last time → no news', () => {
		expect(isRecapNews({ finished: [], waiting: ['a'], waitingSaid: ['a', 'b'] })).toBe(false);
	});

	it('nothing waiting any more → no news', () => {
		expect(isRecapNews({ finished: [], waiting: [], waitingSaid: ['a'] })).toBe(false);
	});
});

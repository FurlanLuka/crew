import { describe, expect, it } from 'bun:test';
import type { Input, State } from '../shared/protocol.js';
import { run, worktree } from '../../test/support/reduce.js';
import { MAX_NAME_LENGTH, toSessionName } from './names.js';

const VM1 = { id: 'vm1', host: 'dev@vm1.example.com', name: 'Personal' };
const REMOTE = 'vm1:crew/main';
const LOCAL = 'crew/main';
const OTHER = 'crew/wrk1';

const connected = (extra: Input[] = []): State =>
	run([
		{ type: 'machines', machines: [VM1] },
		{
			type: 'worktrees',
			worktrees: [worktree(LOCAL), worktree(OTHER), { ...worktree(REMOTE), label: 'crew/main' }],
		},
		{ type: 'machine_resynced', id: 'vm1', inputs: [] },
		...extra,
	]).state;

describe('toSessionName', () => {
	it('"  api   work " → "api work"; "" and "\\t" → ""', () => {
		expect(toSessionName('  api   work ')).toBe('api work');
		expect(toSessionName('')).toBe('');
		expect(toSessionName('\t')).toBe('');
	});

	it('a name past the cap → cut to it, no trailing space', () => {
		expect(toSessionName(`${'a'.repeat(MAX_NAME_LENGTH - 1)} tail`)).toBe(
			'a'.repeat(MAX_NAME_LENGTH - 1),
		);
	});
});

describe('rename_session', () => {
	it('a name with stray spaces → set, trimmed; the same again → unchanged', () => {
		const once = connected([{ type: 'rename_session', ref: REMOTE, name: '  voice   os dev ' }]);
		const twice = run([{ type: 'rename_session', ref: REMOTE, name: 'voice os dev' }], {
			start: once,
		}).state;

		expect(once.names).toEqual({ [REMOTE]: 'voice os dev' });
		expect(twice.names).toBe(once.names);
	});

	it('renamed again → the new name replaces the old', () => {
		const state = connected([
			{ type: 'rename_session', ref: LOCAL, name: 'shop' },
			{ type: 'rename_session', ref: LOCAL, name: 'storefront' },
		]);

		expect(state.names).toEqual({ [LOCAL]: 'storefront' });
	});

	it('an empty or blank name → cleared; clearing an unnamed session → nothing', () => {
		const state = connected([
			{ type: 'rename_session', ref: LOCAL, name: 'shop' },
			{ type: 'rename_session', ref: OTHER, name: 'docs' },
			{ type: 'rename_session', ref: LOCAL, name: '   ' },
			{ type: 'rename_session', ref: REMOTE, name: '' },
		]);

		expect(state.names).toEqual({ [OTHER]: 'docs' });
	});

	it("another session's name, however spelled → refused, both keep theirs", () => {
		const state = connected([
			{ type: 'rename_session', ref: LOCAL, name: 'voice os dev' },
			{ type: 'rename_session', ref: REMOTE, name: 'Voice-OS Dev' },
		]);

		expect(state.names).toEqual({ [LOCAL]: 'voice os dev' });
	});

	it('its own name in another spelling → taken as the new spelling', () => {
		const state = connected([
			{ type: 'rename_session', ref: LOCAL, name: 'voice os dev' },
			{ type: 'rename_session', ref: LOCAL, name: 'Voice OS Dev' },
		]);

		expect(state.names).toEqual({ [LOCAL]: 'Voice OS Dev' });
	});

	it('a session crew does not have, or a name with no letter or digit → nothing', () => {
		const state = connected([
			{ type: 'rename_session', ref: 'crew/wrk9', name: 'ghost' },
			{ type: 'rename_session', ref: LOCAL, name: '!!!' },
		]);

		expect(state.names).toEqual({});
	});

	it('a name past 60 characters by voice → kept at 60', () => {
		const state = connected([{ type: 'rename_session', ref: LOCAL, name: 'x'.repeat(80) }]);

		expect(state.names).toEqual({ [LOCAL]: 'x'.repeat(MAX_NAME_LENGTH) });
	});

	it('a named ref whose session is gone → renamed or cleared by its name', () => {
		const named = connected([{ type: 'names_loaded', names: { 'crew/wrk9': 'ghost' } }]);
		const renamed = run([{ type: 'rename_session', ref: 'crew/wrk9', name: 'spirit' }], {
			start: named,
		}).state;
		const cleared = run([{ type: 'rename_session', ref: 'crew/wrk9', name: '' }], {
			start: renamed,
		}).state;

		expect(renamed.names).toEqual({ 'crew/wrk9': 'spirit' });
		expect(cleared.names).toEqual({});
	});

	it('a session of a machine out of reach → renamed, nothing said, nothing sent', () => {
		const { state, effects } = run(
			[
				{ type: 'machine_status', id: 'vm1', status: 'unreachable', detail: 'timeout' },
				{ type: 'rename_session', ref: REMOTE, name: 'voice os dev' },
			],
			{ start: connected() },
		);

		expect(state.names).toEqual({ [REMOTE]: 'voice os dev' });
		expect(effects).toEqual([]);
	});
});

describe('names_loaded', () => {
	it('saved names → kept for this Mac and known machines, dropped for an unknown one', () => {
		const state = connected([
			{
				type: 'names_loaded',
				names: { [LOCAL]: 'shop', [REMOTE]: 'voice os dev', 'gpu:crew/main': 'gpu dev' },
			},
		]);

		expect(state.names).toEqual({ [LOCAL]: 'shop', [REMOTE]: 'voice os dev' });
	});

	it('a name given before they loaded → kept over the saved one; a saved name it took → dropped', () => {
		const state = connected([
			{ type: 'rename_session', ref: LOCAL, name: 'voice os dev' },
			{
				type: 'names_loaded',
				names: { [LOCAL]: 'shop', [REMOTE]: 'voice os dev', [OTHER]: 'docs' },
			},
		]);

		expect(state.names).toEqual({ [LOCAL]: 'voice os dev', [OTHER]: 'docs' });
	});

	it('saved names that normalise to nothing → dropped; stray spacing → folded', () => {
		const state = connected([
			{
				type: 'names_loaded',
				names: { [LOCAL]: '   ', [OTHER]: '!!!', [REMOTE]: '  voice   os dev ' },
			},
		]);

		expect(state.names).toEqual({ [REMOTE]: 'voice os dev' });
	});
});

describe('names of a machine that goes away', () => {
	it('remove_machine → its names dropped, this Mac keeps its own', () => {
		const state = connected([
			{ type: 'rename_session', ref: REMOTE, name: 'voice os dev' },
			{ type: 'rename_session', ref: LOCAL, name: 'shop' },
			{ type: 'remove_machine', id: 'vm1' },
		]);

		expect(state.names).toEqual({ [LOCAL]: 'shop' });
	});

	it('its machine gone from machines.json → its names dropped', () => {
		const state = connected([
			{ type: 'rename_session', ref: REMOTE, name: 'voice os dev' },
			{ type: 'machines', machines: [] },
		]);

		expect(state.names).toEqual({});
	});
});

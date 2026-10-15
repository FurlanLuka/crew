import { describe, expect, it } from 'bun:test';
import type { StreamItem } from '../../shared/protocol.js';
import { findFocus, pickFocus } from './focus.js';

const REFS = ['store/main', 'store/wrk1', 'signals/main'];

let next = 0;
const bash = (command: string): StreamItem => ({
	id: `t${next++}`,
	at: 0,
	kind: 'tool',
	name: 'Bash',
	summary: `run ${command}`,
});
const said = (text: string): StreamItem => ({ id: `u${next++}`, at: 0, kind: 'user', text });
const reply = (text: string): StreamItem => ({ id: `r${next++}`, at: 0, kind: 'text', text });

const refOf = (stream: StreamItem[]) => findFocus({ stream, refs: REFS })?.ref ?? null;

describe('findFocus', () => {
	it.each([
		['crew dev check store/wrk1', 'store/wrk1'],
		['crew verify store/main --json', 'store/main'],
		['cd /tmp && crew run store/wrk1 store-api -- pnpm test', 'store/wrk1'],
		['crew dev start signals', 'signals/main'],
		['crew dev start store', null],
		['crew env other/main store-api', null],
		['ls ~/.crew/workspaces/store/main/store-api', null],
		['git log crew/store/wrk1/store-api', null],
		['crew dev logs other/main web > store/wrk1.log', null],
		['crew dev check store/wrk1.', 'store/wrk1'],
	])('%s → %s', (command, ref) => expect(refOf([bash(command)])).toBe(ref));

	it('a message sent names one too; a reply of Claude does not', () => {
		expect(refOf([said('checkout keeps dying on store/wrk1')])).toBe('store/wrk1');
		expect(refOf([reply('store/main works because Postgres is up')])).toBeNull();
	});

	it('the last one named wins, across the stream and within one command', () => {
		expect(refOf([bash('crew dev check store/main'), said('now store/wrk1')])).toBe('store/wrk1');
		expect(refOf([bash('crew dev logs store/main web && crew dev check store/wrk1')])).toBe(
			'store/wrk1',
		);
	});

	it('a Bash command without crew is not about a worktree', () =>
		expect(refOf([bash('echo store/main')])).toBeNull());

	it('says where it was named', () => {
		const stream = [said('hi'), bash('crew verify store/main')];

		expect(findFocus({ stream, refs: REFS })).toEqual({
			ref: 'store/main',
			atId: stream[1]?.id ?? '',
			index: 1,
		});
	});
});

describe('pickFocus', () => {
	const found = { ref: 'store/main', atId: 't9', index: 4 };

	it('found → open; closed on that mention → shut; a newer mention → open again', () => {
		expect(pickFocus({ found, asked: null, closedAt: null })).toEqual({
			ref: 'store/main',
			closeKey: 't9',
		});
		expect(pickFocus({ found, asked: null, closedAt: 't9' })).toBeNull();
		expect(
			pickFocus({ found: { ...found, atId: 't10', index: 5 }, asked: null, closedAt: 't9' })?.ref,
		).toBe('store/main');
	});

	it('a Fix with Claude opens its worktree at once, until the stream names one after it', () => {
		const asked = { ref: 'store/wrk1', afterIndex: 5 };

		expect(pickFocus({ found, asked, closedAt: null })).toEqual({
			ref: 'store/wrk1',
			closeKey: 'ask 5',
		});
		expect(pickFocus({ found: null, asked, closedAt: null })?.ref).toBe('store/wrk1');
		expect(pickFocus({ found: { ...found, index: 6 }, asked, closedAt: null })?.ref).toBe(
			'store/main',
		);
		expect(pickFocus({ found, asked, closedAt: 'ask 5' })).toBeNull();
		// Closing the Fix with Claude panel never hides a mention after it.
		expect(
			pickFocus({ found: { ...found, atId: 't12', index: 6 }, asked, closedAt: 'ask 5' }),
		).toEqual({ ref: 'store/main', closeKey: 't12' });
	});

	it('nothing named → no panel', () =>
		expect(pickFocus({ found: null, asked: null, closedAt: null })).toBeNull());
});

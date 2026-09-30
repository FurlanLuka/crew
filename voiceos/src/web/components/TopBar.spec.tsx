import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { State } from '../../shared/protocol.js';
import { createInitialState, createSession } from '../../state/reducer.js';
import { TopBar } from './TopBar.js';

const withSessions = (refs: string[]): State => ({
	...createInitialState(),
	sessions: Object.fromEntries(
		refs.map((ref) => [
			ref,
			createSession({ ref, label: ref, branch: 'b', cwd: '/w', dirs: [], isPinned: false }),
		]),
	),
});

const render = (state: State): string =>
	renderToStaticMarkup(<TopBar state={state} dispatch={() => {}} />);

describe('TopBar', () => {
	it('one session → "1 session"', () =>
		expect(render(withSessions(['store-front/main']))).toContain('<span>1 session</span>'));

	it('two sessions → "2 sessions"', () =>
		expect(render(withSessions(['store-front/main', 'checkout-api/main']))).toContain(
			'<span>2 sessions</span>',
		));

	it('no sessions → "0 sessions"', () =>
		expect(render(withSessions([]))).toContain('<span>0 sessions</span>'));
});

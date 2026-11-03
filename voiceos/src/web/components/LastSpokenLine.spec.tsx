import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { State } from '../../shared/protocol.js';
import { createInitialState } from '../../state/reducer.js';
import { LastSpokenLine } from './LastSpokenLine.js';

const withLine = (patch: Partial<State> = {}): State => ({
	...createInitialState(),
	spoken: [{ id: 's1', text: 'Tests pass.', source: 'kernel', at: Date.now() }],
	...patch,
});

const hasWave = (state: State) =>
	renderToStaticMarkup(<LastSpokenLine state={state} />).includes('<svg');

describe('LastSpokenLine', () => {
	it('a line that was played shows the waveform', () => expect(hasWave(withLine())).toBe(true));

	it('voice off or speech off: nothing was played, so no waveform', () => {
		expect(hasWave(withLine({ voiceOff: true }))).toBe(false);
		expect(hasWave(withLine({ speechOff: true }))).toBe(false);
	});
});

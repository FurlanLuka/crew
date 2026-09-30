import { describe, expect, it } from 'bun:test';
import type { Input, State } from '../shared/protocol.js';
import { REF, run, runningSession } from '../../test/support/reduce.js';
import type { Effect } from './reducer.js';

// 105 words, its question last: past the old 70-word cap, which cut the question off (note 80).
const LONG_ASKING_LINE = `${'The parser now handles nested quotes and escaped brackets correctly everywhere. '.repeat(9).trim()} Should I push the branch now?`;

const onScreen = (state: State): State => ({ ...state, view: { kind: 'session', ref: REF } });
const said = (effects: Effect[]) =>
	effects.flatMap((effect) => (effect.type === 'speak' ? [effect.text] : []));

describe('speakNewTag', () => {
	it('a 105-word tag on screen → said whole, its closing question kept', () => {
		const { effects } = run(
			[{ type: 'assistant_text', ref: REF, text: `<spoken>${LONG_ASKING_LINE}</spoken>\nMore.` }],
			{ start: onScreen(runningSession()) },
		);

		expect(said(effects)).toEqual([LONG_ASKING_LINE]);
	});

	it('a long tag streamed, then its final message → said once, whole', () => {
		const message = `<spoken>${LONG_ASKING_LINE}</spoken>\nDetails.`;
		const deltas: Input[] = [message.slice(0, 200), message.slice(200)].map((text) => ({
			type: 'text_delta',
			ref: REF,
			text,
		}));
		let state = onScreen(runningSession());
		const spoken: string[] = [];

		for (const input of [...deltas, { type: 'assistant_text', ref: REF, text: message } as Input]) {
			const result = run([input], { start: state });
			state = result.state;
			spoken.push(...said(result.effects));
		}

		expect(spoken).toEqual([LONG_ASKING_LINE]);
	});
});

import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInitialState } from '../../state/reducer.js';
import { VoiceMoment } from '../home/VoiceMoment.js';
import { TopBar } from './TopBar.js';

const renderTop = (voiceOff: boolean) =>
	renderToStaticMarkup(
		<TopBar
			state={{ ...createInitialState(), voiceOff }}
			dispatch={() => undefined}
			onHome={() => undefined}
			onNewSession={() => undefined}
		/>,
	);

describe('voice off on the page', () => {
	it('the top bar: "voice" to mute; struck while off, its label the way back', () => {
		expect(renderTop(false)).toContain('aria-label="Mute voice"');
		const off = renderTop(true);

		expect(off).toContain('class="vo-voice off ');
		expect(off).toContain('aria-label="Turn voice on"');
	});

	it('the moment: "Voice" struck through only while voice is off', () => {
		const struck = renderToStaticMarkup(<VoiceMoment isStruck onDone={() => undefined} />);
		const whole = renderToStaticMarkup(<VoiceMoment onDone={() => undefined} />);

		expect(struck).toContain('<s class="struck">Voice</s> OS');
		expect(whole).not.toContain('<s');
		expect(whole).toContain('Voice OS');
	});
});

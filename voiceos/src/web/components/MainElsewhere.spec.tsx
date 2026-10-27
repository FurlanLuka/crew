import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MainElsewhere } from './MainElsewhere.js';

describe('MainElsewhere', () => {
	it('says where Voice OS is open, with Use here', () => {
		const html = renderToStaticMarkup(
			<MainElsewhere device="iPhone" onUseHere={() => undefined} />,
		);

		expect(html).toContain('Voice OS is open on iPhone');
		expect(html).toContain('>Use here</button>');
	});

	it('a device it could not name is another screen', () =>
		expect(renderToStaticMarkup(<MainElsewhere device="" onUseHere={() => undefined} />)).toContain(
			'Voice OS is open on another screen',
		));
});

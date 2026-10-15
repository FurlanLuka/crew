import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PeerRun, StreamItem } from '../../shared/protocol.js';
import { createSession } from '../../state/reducer.js';
import { PeerCard } from './PeerCard.js';
import { QueueList } from './QueueList.js';
import { PeerRunDialog } from './PeerRunDialog.js';
import { PeerRunsPanel } from './PeerRunsPanel.js';
import { StreamLine } from './StreamLine.js';

type AskCard = Extract<StreamItem, { kind: 'session_ask' }>;

const card = (patch: Partial<AskCard> = {}): AskCard => ({
	id: 'peer:r1:asker',
	at: 1_000,
	kind: 'session_ask',
	requestId: 'r1',
	request: 'ask',
	peer: 'checkout-api/main',
	peerRef: 'checkout-api/main',
	text: 'Which retry limit?',
	status: 'asking',
	...patch,
});

const RUN: PeerRun = {
	requestId: 'r1',
	kind: 'ask',
	fromRef: 'store-front/main',
	fromLabel: 'store-front/main',
	text: 'Which retry limit?',
	status: 'asking',
	startedAt: 1_000,
	settledAt: null,
	step: 'search for MAX_RETRIES',
	items: [
		{ id: 'a', at: 2, kind: 'text', text: 'Let me look.' },
		{ id: 'b', at: 3, kind: 'tool', name: 'Grep', summary: 'search for MAX_RETRIES' },
	],
	answer: null,
};

const render = (item: AskCard, run?: PeerRun, onOpen?: () => void) =>
	renderToStaticMarkup(
		<PeerCard item={item} {...(run ? { run } : {})} {...(onOpen ? { onOpen } : {})} />,
	);

describe('PeerCard', () => {
	it('waiting → Asking, the other session with its initials, a Waiting pill, the live step and View steps', () => {
		const html = render(card(), RUN, () => undefined);

		expect(html).toContain('<span>Asking</span>');
		expect(html).toContain('>CA</span>checkout-api/main');
		expect(html).toContain('<span class="pc-pill wait">Waiting</span>');
		expect(html).toContain('A copy of checkout-api/main is looking · search for MAX_RETRIES');
		expect(html).toContain('View steps');
	});

	it('waiting with no run here (another page, or an old remote) → no step and no View steps', () => {
		const html = render(card());

		expect(html).toContain('A copy of checkout-api/main is looking');
		expect(html).not.toContain(' · search');
		expect(html).not.toContain('View steps');
	});

	it('answered → how long it took, the answer, the files read and View steps', () => {
		const html = render(
			card({
				status: 'answered',
				settledAt: 10_000,
				answer: 'Five **tries**.',
				read: ['src/retry.ts'],
			}),
			{ ...RUN, status: 'answered', settledAt: 10_000 },
			() => undefined,
		);

		expect(html).toContain('<span class="pc-pill ok">Answered · 9s</span>');
		expect(html).toContain('<strong>tries</strong>');
		expect(html).toContain('<code>src/retry.ts</code>');
		expect(html).toContain('View steps');
	});

	it('a tell → Told, Queued then Delivered; its files as chips; dropped → Not delivered with why', () => {
		const tell = card({ request: 'tell', status: 'queued', text: 'Heads up.' });

		expect(render(tell)).toContain('<span>Told</span>');
		expect(render(tell)).toContain('<span class="pc-pill muted">Queued</span>');
		expect(render({ ...tell, status: 'delivered' })).toContain(
			'<span class="pc-pill ok">Delivered</span>',
		);

		const dropped = render({
			...tell,
			status: 'failed',
			answer: 'not delivered: it left the queue',
		});

		expect(dropped).toContain('<span class="pc-pill bad">Not delivered</span>');
		expect(dropped).toContain('not delivered: it left the queue');
	});

	it('a secret → a lock and the name; copied → the private file, never a value; refused → why', () => {
		const secret = card({ request: 'secret', status: 'waiting_ok', text: 'STRIPE_KEY' });

		expect(render(secret)).toContain('lock-icon');
		expect(render(secret)).toContain('<span>for a secret</span>');
		expect(render(secret)).toContain('<code>STRIPE_KEY</code>');
		expect(render(secret)).toContain('Needs your OK');

		const copied = render({ ...secret, status: 'answered', answer: '/s/r1/STRIPE_KEY.env' });

		expect(copied).toContain('<span class="pc-pill ok">Copied</span>');
		expect(copied).toContain('In a private file <code>/s/r1/STRIPE_KEY.env</code>');
		expect(copied).toContain('Neither session saw the value.');
		expect(render({ ...secret, status: 'refused', answer: 'the developer said no' })).toContain(
			'the developer said no',
		);
	});
});

describe('StreamLine', () => {
	it("another session's words → a From card, never the developer's ›", () => {
		const html = renderToStaticMarkup(
			<StreamLine
				item={{ id: 'u', at: 1, kind: 'user', text: 'Heads up.', from: 'store-front/main' }}
			/>,
		);

		expect(html).toContain('<span>From</span>');
		expect(html).toContain('store-front/main');
		expect(html).not.toContain('›');
	});

	it('a btw → a grey BTW bubble with its answer', () => {
		const html = renderToStaticMarkup(
			<StreamLine
				item={{
					id: 'a',
					at: 1,
					kind: 'aside',
					question: 'btw, which branch?',
					answer: 'main',
					status: 'answered',
				}}
			/>,
		);

		expect(html).toContain(
			'<div class="btw" data-status="answered"><div class="btw-q"><b>BTW</b>which branch?',
		);
		expect(html).toContain('main');
	});
});

describe('PeerRunsPanel', () => {
	const renderPanel = (runs: PeerRun[]) =>
		renderToStaticMarkup(<PeerRunsPanel runs={runs} onOpen={() => undefined} />);

	it('nothing asked → nothing drawn', () => expect(renderPanel([])).toBe(''));

	it('an ask still going → who asked, the question and its live step, a row that opens', () => {
		const html = renderPanel([RUN]);

		expect(html).toContain('asked by other sessions · 1');
		expect(html).toContain('store-front/main');
		expect(html).toContain('Which retry limit?');
		expect(html).toContain('▸ search for MAX_RETRIES');
		expect(html).toContain('<button type="button" class="subagent" data-request="r1"');
	});

	it('a secret → a lock and "copy of NAME", and no steps to open', () => {
		const html = renderPanel([
			{ ...RUN, kind: 'secret', text: 'STRIPE_KEY', status: 'waiting_ok', step: null },
		]);

		expect(html).toContain('copy of STRIPE_KEY');
		expect(html).toContain('waiting for your OK');
		expect(html).not.toContain('<button');
	});
});

describe('PeerRunDialog', () => {
	it('the copy, the question, its steps, then the answer and where it went', () => {
		const html = renderToStaticMarkup(
			<PeerRunDialog
				run={{ ...RUN, status: 'answered', settledAt: 10_000, answer: 'Five.' }}
				sessionLabel="checkout-api/main"
				onClose={() => undefined}
			/>,
		);

		expect(html).toContain('question from store-front/main');
		expect(html).toContain('A copy of checkout-api/main');
		expect(html).toContain('search for MAX_RETRIES');
		expect(html).toContain('answer · sent back to store-front/main');
		expect(html).toContain('Only Read, Grep and Glob run here.');
	});
});

describe('QueueList', () => {
	it("another session's queued words → labelled from it", () => {
		const session = {
			...createSession({
				ref: 'checkout',
				label: 'checkout',
				branch: 'b',
				cwd: '/w',
				dirs: [],
				isPinned: false,
			}),
			queue: [
				{ id: 'q1', text: 'Heads up.', at: 1, from: { ref: 'store', label: 'store-front/main' } },
			],
		};
		const html = renderToStaticMarkup(<QueueList session={session} dispatch={() => undefined} />);

		expect(html).toContain('from store-front/main · ');
		expect(html).toContain('Heads up.');
	});
});

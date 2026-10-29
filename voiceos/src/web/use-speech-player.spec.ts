import { afterEach, describe, expect, it } from 'bun:test';
import { PcmPlayer } from './use-speech-player.js';

describe('PcmPlayer muted', () => {
	it('plays nothing and reports nothing: the main screen plays it, and the server times the rest', () => {
		const player = new PcmPlayer();
		const done: string[] = [];
		player.setNotify((id) => done.push(id));
		player.setMuted(true);

		// No AudioContext is touched: Bun has none, so playing would throw here.
		expect(() => {
			player.receive({ type: 'audio', id: 'a1', base64: 'AAAA', isLast: false, hasChime: true });
			player.receive({ type: 'audio', id: 'a1', base64: '', isLast: true });
			player.playChime();
		}).not.toThrow();
		expect(done).toEqual([]);
	});
});

interface FakeContext {
	state: string;
	resumes: number;
	closed: boolean;
	onstatechange: (() => void) | null;
}

// Enough of an AudioContext for the player: a state, resume and close, and sources that never end.
const createFakeContext = (
	state: string,
	resumeTo: string,
	isResumeRefused = false,
): FakeContext & AudioContext & { stopped: number } => {
	const context = {
		state,
		resumes: 0,
		stopped: 0,
		closed: false,
		onstatechange: null,
		currentTime: 0,
		destination: {},
		resume() {
			context.resumes++;
			context.state = resumeTo;

			return isResumeRefused ? Promise.reject(new Error('not allowed')) : Promise.resolve();
		},
		close() {
			context.closed = true;

			return Promise.resolve();
		},
		createBuffer: (_channels: number, length: number, rate: number) => ({
			duration: length / rate,
			copyToChannel: () => {},
		}),
		createBufferSource: () => ({
			connect: () => {},
			start: () => {},
			stop: () => {
				context.stopped++;
			},
		}),
	};

	return context as unknown as FakeContext & AudioContext & { stopped: number };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('PcmPlayer waking', () => {
	afterEach(() => {
		delete (globalThis as { document?: unknown }).document;
	});

	it('nudges an interrupted context awake when a clip arrives, once per clip', () => {
		const context = createFakeContext('interrupted', 'running');
		const player = new PcmPlayer(() => context, true);
		// The first chunk makes the context: interrupted, so it is woken.
		player.receive({ type: 'audio', id: 'a1', base64: 'AAAA', isLast: false });
		player.receive({ type: 'audio', id: 'a1', base64: 'AAAA', isLast: false });

		expect(context.resumes).toBe(1);
	});

	it('makes a new context when a gesture cannot start the old one', async () => {
		const stuck = createFakeContext('interrupted', 'interrupted');
		const fresh = createFakeContext('suspended', 'running');
		const contexts = [stuck, fresh];
		const player = new PcmPlayer(() => contexts.shift() as AudioContext, true);

		player.resume();
		await flush();

		expect(stuck.closed).toBe(true);
		expect(fresh.resumes).toBe(1);
	});

	it('a clip on a stuck context is cut when the context is remade, and never reports done', async () => {
		const stuck = createFakeContext('interrupted', 'interrupted');
		const contexts = [stuck, createFakeContext('suspended', 'running')];
		const player = new PcmPlayer(() => contexts.shift() as AudioContext, true);
		const done: string[] = [];
		player.setNotify((id) => done.push(id));

		player.receive({ type: 'audio', id: 'a1', base64: 'AAAA', isLast: true });
		player.resume();
		await flush();

		expect(stuck.stopped).toBe(1);
		expect(stuck.closed).toBe(true);
		expect(done).toEqual([]);
	});

	it('the rest of a clip cut by a remade context is dropped, and nothing reports done', async () => {
		const stuck = createFakeContext('interrupted', 'interrupted');
		const fresh = createFakeContext('suspended', 'running');
		const contexts = [stuck, fresh];
		const player = new PcmPlayer(() => contexts.shift() as AudioContext, true);
		const done: string[] = [];
		player.setNotify((id) => done.push(id));

		player.receive({ type: 'audio', id: 'a1', base64: 'AAAA', isLast: false });
		player.resume();
		await flush();
		player.receive({ type: 'audio', id: 'a1', base64: 'AAAA', isLast: false });
		player.receive({ type: 'audio', id: 'a1', base64: '', isLast: true });

		expect(fresh.resumes).toBe(1);
		expect(done).toEqual([]);
		// A later clip with that id plays again: the cut is forgotten with its last chunk.
		player.receive({ type: 'audio', id: 'a1', base64: 'AAAA', isLast: false });
		expect(fresh.stopped).toBe(0);
	});

	it('a cut clip that is then cancelled is forgotten: its id plays again', async () => {
		const stuck = createFakeContext('interrupted', 'interrupted');
		const fresh = createFakeContext('running', 'running');
		const contexts = [stuck, fresh];
		const player = new PcmPlayer(() => contexts.shift() as AudioContext, true);
		const done: string[] = [];
		player.setNotify((id) => done.push(id));

		player.receive({ type: 'audio', id: 'a1', base64: 'AAAA', isLast: false });
		player.resume();
		await flush();
		player.receive({ type: 'audio_cancel', id: 'a1' });
		player.receive({ type: 'audio', id: 'a1', base64: 'AAAA', isLast: false });
		player.receive({ type: 'audio', id: 'a1', base64: '', isLast: true });

		// Played on the fresh context: its source "ends" only in a browser, so it is still open.
		expect(done).toEqual([]);
		player.stop();
		expect(fresh.stopped).toBe(1);
	});

	it('a cut clip whose last chunk comes while muted is forgotten too', async () => {
		const stuck = createFakeContext('interrupted', 'interrupted');
		const fresh = createFakeContext('running', 'running');
		const contexts = [stuck, fresh];
		const player = new PcmPlayer(() => contexts.shift() as AudioContext, true);

		player.receive({ type: 'audio', id: 'a1', base64: 'AAAA', isLast: false });
		player.resume();
		await flush();
		player.setMuted(true);
		player.receive({ type: 'audio', id: 'a1', base64: '', isLast: true });
		player.setMuted(false);
		player.receive({ type: 'audio', id: 'a1', base64: 'AAAA', isLast: false });
		player.stop();

		expect(fresh.stopped).toBe(1);
	});

	it('a refused resume still remakes the context', async () => {
		const stuck = createFakeContext('interrupted', 'interrupted', true);
		const contexts = [stuck, createFakeContext('suspended', 'running')];
		const player = new PcmPlayer(() => contexts.shift() as AudioContext, true);

		player.resume();
		await flush();

		expect(stuck.closed).toBe(true);
	});

	it('two gestures on a stuck context make one new context, not two', async () => {
		const stuck = createFakeContext('interrupted', 'interrupted');
		const fresh = createFakeContext('suspended', 'running');
		const spare = createFakeContext('suspended', 'running');
		const contexts = [stuck, fresh, spare];
		const player = new PcmPlayer(() => contexts.shift() as AudioContext, true);

		// A tap fires pointerdown and keydown: both ask before either resume settles.
		player.resume();
		player.resume();
		await flush();

		expect(stuck.closed).toBe(true);
		expect(fresh.closed).toBe(false);
		expect(contexts).toEqual([spare]);
	});

	it('a locked phone keeps its context and its clips: a hidden page cannot start audio', async () => {
		(globalThis as { document?: unknown }).document = { visibilityState: 'hidden' };
		const stuck = createFakeContext('interrupted', 'interrupted', true);
		const player = new PcmPlayer(() => stuck, true);

		player.receive({ type: 'audio', id: 'a1', base64: 'AAAA', isLast: false });
		player.resume();
		await flush();

		expect(stuck.closed).toBe(false);
		expect(stuck.stopped).toBe(0);
	});

	it('keeps a context that a gesture started', async () => {
		const context = createFakeContext('suspended', 'running');
		let made = 0;
		const player = new PcmPlayer(() => {
			made++;

			return context;
		}, false);

		player.resume();
		await flush();

		expect(made).toBe(1);
		expect(context.closed).toBe(false);
	});
});

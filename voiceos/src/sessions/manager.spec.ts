import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureLog } from '../log.js';
import { Store } from '../state/store.js';
import { SessionManager, connectStore } from './manager.js';
import { loadRegistry, recordSession } from './registry.js';
import { BRIEFING_VERSION } from './voice-context.js';
import { describeAttached, resolveAttachment, storeAttachment } from './attachments.js';
import { createFakeQuery, type FakeQueryParams } from '../../test/support/fake-query.js';

configureLog({ quiet: true });

const createHarness = () => {
	const store = new Store();

	store.dispatch({
		type: 'worktrees',
		worktrees: [
			{
				ref: 'store-front/main',
				label: 'store-front/main',
				branch: '',
				cwd: '/w/main',
				dirs: [],
				isPinned: false,
			},
		],
	});

	const orientation = Promise.withResolvers<string>();
	const fake = createFakeQuery();
	const manager = new SessionManager({
		...connectStore(store),
		registryFile: join(mkdtempSync(join(tmpdir(), 'voiceos-mgr-')), 'sessions.json'),
		home: '/h',
		fetchOrientation: () => orientation.promise,
		runQuery: fake.runQuery,
	});

	store.onEffect(manager.handle);

	return { store, manager, orientation, started: fake.started, prompts: fake.prompts };
};

const waitTick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('SessionManager', () => {
	it("every session is told it is driven by Voice OS, after crew's orientation", async () => {
		const harness = createHarness();
		harness.store.dispatch({ type: 'activate', ref: 'store-front/main' });
		harness.orientation.resolve('## crew\nuse crew dev start');
		await waitTick();
		const prompt = harness.prompts[0] ?? '';
		expect(prompt.startsWith('## crew')).toBe(true);
		expect(prompt).toContain('## Voice OS');
		expect(prompt).toContain('AskUserQuestion');
		harness.manager.stopAll();
	});

	it("crew's orientation unavailable → the session still gets the Voice OS context", async () => {
		const store = new Store();
		store.dispatch({
			type: 'worktrees',
			worktrees: [
				{
					ref: 'store-front/main',
					label: 'store-front/main',
					branch: '',
					cwd: '/w/main',
					dirs: [],
					isPinned: false,
				},
			],
		});
		const fake = createFakeQuery();
		const manager = new SessionManager({
			...connectStore(store),
			registryFile: join(mkdtempSync(join(tmpdir(), 'voiceos-mgr-')), 'sessions.json'),
			home: '/h',
			fetchOrientation: () => Promise.reject(new Error('crew start failed')),
			runQuery: fake.runQuery,
		});
		store.onEffect(manager.handle);
		store.dispatch({ type: 'activate', ref: 'store-front/main' });
		await waitTick();
		expect(fake.prompts[0]?.startsWith('## Voice OS')).toBe(true);
		manager.stopAll();
	});

	it('start → one worker once the orientation arrives; session goes idle', async () => {
		const harness = createHarness();
		harness.store.dispatch({ type: 'activate', ref: 'store-front/main' });
		harness.orientation.resolve('orientation');
		await waitTick();

		expect(harness.started).toEqual(['/w/main']);
		expect(harness.manager.listRunning()).toEqual(['store-front/main']);
		expect(harness.store.state.sessions['store-front/main']?.status).toBe('idle');
		harness.manager.stopAll();
	});

	it('stop while the orientation loads → no worker spawns, session stays stopped', async () => {
		const harness = createHarness();
		harness.store.dispatch({ type: 'activate', ref: 'store-front/main' });
		harness.store.dispatch({ type: 'deactivate', ref: 'store-front/main' });
		harness.orientation.resolve('orientation');
		await waitTick();

		expect(harness.started).toEqual([]);
		expect(harness.manager.listRunning()).toEqual([]);
		expect(harness.store.state.sessions['store-front/main']?.status).toBe('stopped');
	});

	it('start, stop, start quickly → exactly one worker, none orphaned', async () => {
		const harness = createHarness();
		harness.store.dispatch({ type: 'activate', ref: 'store-front/main' });
		harness.store.dispatch({ type: 'deactivate', ref: 'store-front/main' });
		harness.store.dispatch({ type: 'activate', ref: 'store-front/main' });
		harness.orientation.resolve('orientation');
		await waitTick();

		expect(harness.started).toHaveLength(1);
		expect(harness.manager.listRunning()).toEqual(['store-front/main']);
		harness.store.dispatch({ type: 'deactivate', ref: 'store-front/main' });
		await waitTick();
		expect(harness.manager.listRunning()).toEqual([]);
	});

	it('a second start while one is preparing → ignored', async () => {
		const harness = createHarness();
		harness.store.dispatch({ type: 'activate', ref: 'store-front/main' });
		harness.manager.handle({ type: 'worker_start', ref: 'store-front/main' });
		harness.orientation.resolve('orientation');
		await waitTick();

		expect(harness.started).toHaveLength(1);
		harness.manager.stopAll();
	});

	it('stop → the pending permission ask is denied through the reducer, not left hanging', async () => {
		const harness = createHarness();
		harness.store.dispatch({ type: 'activate', ref: 'store-front/main' });
		harness.orientation.resolve('orientation');
		await waitTick();
		const answer = harness.manager.permissions.canUseTool('store-front/main')(
			'Bash',
			{ command: 'ls' },
			{},
		);
		harness.store.dispatch({ type: 'deactivate', ref: 'store-front/main' });

		expect(await answer).toEqual({ behavior: 'deny', message: 'The session was stopped.' });
	});

	it("the question's X → Claude's AskUserQuestion is denied with why, and the ask closes", async () => {
		const harness = createHarness();
		harness.store.dispatch({ type: 'activate', ref: 'store-front/main' });
		harness.orientation.resolve('orientation');
		await waitTick();
		const answer = harness.manager.permissions.canUseTool('store-front/main')(
			'AskUserQuestion',
			{ questions: [{ question: 'Which table?', options: [{ label: 'New' }] }] },
			{},
		);
		const askId = harness.store.state.asks[0]?.id ?? '';
		harness.store.dispatch({ type: 'decline_question', askId });

		expect(await answer).toEqual({
			behavior: 'deny',
			message: 'The developer declined to answer this question.',
		});
		expect(harness.store.state.asks).toEqual([]);
		expect(harness.manager.permissions.countPending()).toBe(0);
		harness.manager.stopAll();
	});

	describe('briefing a resumed session', () => {
		const createResumedHarness = (
			briefing?: string,
			{ failResume = false, resumeError }: { failResume?: boolean; resumeError?: string } = {},
		) => {
			const store = new Store();
			store.dispatch({
				type: 'worktrees',
				worktrees: [
					{
						ref: 'store-front/main',
						label: 'store-front/main',
						branch: '',
						cwd: '/w/main',
						dirs: [],
						isPinned: false,
					},
				],
			});
			const registryFile = join(mkdtempSync(join(tmpdir(), 'voiceos-mgr-')), 'sessions.json');
			// Same id the fake reports, as a real resume keeps its id.
			recordSession({ file: registryFile, ref: 'store-front/main', sessionId: 's-1', briefing });
			const fake = createFakeQuery({ failResume, ...(resumeError ? { resumeError } : {}) });
			const manager = new SessionManager({
				...connectStore(store),
				registryFile,
				home: '/h',
				fetchOrientation: async () => '',
				runQuery: fake.runQuery,
			});
			store.onEffect(manager.handle);

			return { store, manager, fake, registryFile };
		};

		it('created before the current context → the context goes in front of the next message, once; then recorded', async () => {
			const harness = createResumedHarness('older');
			harness.store.dispatch({ type: 'activate', ref: 'store-front/main' });
			await waitTick();
			harness.store.dispatch({ type: 'send', ref: 'store-front/main', text: 'run the tests' });
			await waitTick();
			harness.store.dispatch({ type: 'send', ref: 'store-front/main', text: 'and push' });
			await waitTick();
			expect(harness.fake.sent[0]).toContain('## Voice OS');
			expect(harness.fake.sent[0]?.endsWith('run the tests')).toBe(true);
			expect(harness.fake.sent[1]).toBe('and push');
			expect(loadRegistry(harness.registryFile)['store-front/main']?.briefing).toBe(
				BRIEFING_VERSION,
			);
			harness.manager.stopAll();
		});

		it('already has the current context → messages go as said', async () => {
			const harness = createResumedHarness(BRIEFING_VERSION);
			harness.store.dispatch({ type: 'activate', ref: 'store-front/main' });
			await waitTick();
			harness.store.dispatch({ type: 'send', ref: 'store-front/main', text: 'run the tests' });
			await waitTick();
			expect(harness.fake.sent).toEqual(['run the tests']);
			harness.manager.stopAll();
		});

		it('the stream shows what the developer said, not the briefing', async () => {
			const harness = createResumedHarness('older');
			harness.store.dispatch({ type: 'activate', ref: 'store-front/main' });
			await waitTick();
			harness.store.dispatch({ type: 'send', ref: 'store-front/main', text: 'run the tests' });
			await waitTick();
			expect(harness.store.state.sessions['store-front/main']?.stream.at(-1)).toMatchObject({
				kind: 'user',
				text: 'run the tests',
			});
			harness.manager.stopAll();
		});

		it('started but nothing sent yet → not recorded as briefed', async () => {
			const harness = createResumedHarness('older');
			harness.store.dispatch({ type: 'activate', ref: 'store-front/main' });
			await waitTick();
			expect(loadRegistry(harness.registryFile)['store-front/main']?.briefing).toBe('older');
			harness.manager.stopAll();
		});

		it('a Voice OS note → Claude reads briefing, then the note, then the words; the stream shows only the words', async () => {
			const harness = createResumedHarness('older');
			harness.store.dispatch({ type: 'activate', ref: 'store-front/main' });
			await waitTick();
			harness.store.dispatch({
				type: 'send',
				ref: 'store-front/main',
				text: 'Check the dev server logs.',
				note: '(Voice OS: api died.)',
			});
			await waitTick();
			await waitTick();
			const sent = harness.fake.sent[0] ?? '';
			expect(sent.indexOf('## Voice OS')).toBeLessThan(sent.indexOf('(Voice OS: api died.)'));
			expect(sent.endsWith('(Voice OS: api died.)\n\nCheck the dev server logs.')).toBe(true);
			const session = harness.store.state.sessions['store-front/main'];
			expect(session?.stream.filter((item) => item.kind === 'user')).toEqual([
				expect.objectContaining({ text: 'Check the dev server logs.' }),
			]);
			harness.manager.stopAll();
		});

		it('killed while it reopens → the conversation is kept: no fresh session, the next start resumes it', async () => {
			const harness = createResumedHarness(BRIEFING_VERSION, {
				failResume: true,
				resumeError: 'Claude Code process terminated by signal SIGKILL',
			});
			harness.store.dispatch({ type: 'activate', ref: 'store-front/main' });
			await waitTick();

			// A failed resume never counts as started: nothing fresh took its place.
			expect(harness.fake.started).toHaveLength(0);
			expect(loadRegistry(harness.registryFile)['store-front/main']?.sessionId).toBe('s-1');
			expect(harness.store.state.sessions['store-front/main']?.status).toBe('stopped');
			harness.manager.stopAll();
		});

		it('Claude says the conversation is gone → a fresh one takes its place', async () => {
			const harness = createResumedHarness(BRIEFING_VERSION, { failResume: true });
			harness.store.dispatch({ type: 'activate', ref: 'store-front/main' });
			await waitTick();

			expect(harness.fake.started).toHaveLength(1);
			expect(harness.store.state.sessions['store-front/main']?.status).toBe('idle');
			harness.manager.stopAll();
		});

		it('resume fails → the fresh session has the context in its prompt, so its first message goes as said', async () => {
			const harness = createResumedHarness('older', { failResume: true });
			harness.store.dispatch({ type: 'activate', ref: 'store-front/main' });
			await waitTick();
			harness.store.dispatch({ type: 'send', ref: 'store-front/main', text: 'run the tests' });
			await waitTick();
			expect(harness.fake.prompts[0]).toContain('## Voice OS');
			expect(harness.fake.sent).toEqual(['run the tests']);
			harness.manager.stopAll();
		});
	});

	it('spoken follow-ups while Claude replies → one interrupt, then the rest of the request as one message', async () => {
		const store = new Store();
		store.dispatch({
			type: 'worktrees',
			worktrees: [
				{
					ref: 'store-front/main',
					label: 'store-front/main',
					branch: '',
					cwd: '/w/main',
					dirs: [],
					isPinned: false,
				},
			],
		});
		const fake = createFakeQuery({ holdTurns: true });
		const manager = new SessionManager({
			...connectStore(store),
			registryFile: join(mkdtempSync(join(tmpdir(), 'voiceos-mgr-')), 'sessions.json'),
			home: '/h',
			fetchOrientation: async () => '',
			runQuery: fake.runQuery,
		});
		store.onEffect(manager.handle);
		store.dispatch({ type: 'activate', ref: 'store-front/main' });
		await waitTick();
		store.dispatch({
			type: 'send',
			ref: 'store-front/main',
			text: 'run the tests',
			isSpoken: true,
		});
		await waitTick();
		store.dispatch({
			type: 'send',
			ref: 'store-front/main',
			text: 'only the checkout ones',
			isSpoken: true,
		});
		store.dispatch({
			type: 'send',
			ref: 'store-front/main',
			text: 'and skip the slow ones',
			isSpoken: true,
		});
		await waitTick();
		await waitTick();

		expect(fake.interrupts()).toBe(1);
		expect(fake.sent).toEqual(['run the tests', 'only the checkout ones and skip the slow ones']);
		expect(store.state.sessions['store-front/main']?.status).toBe('running');
		manager.stopAll();
	});

	describe('side answers', () => {
		const createAsideHarness = (sideReply: FakeQueryParams['sideReply']) => {
			const store = new Store();

			store.dispatch({
				type: 'worktrees',
				worktrees: [
					{
						ref: 'store-front/main',
						label: 'store-front/main',
						branch: '',
						cwd: '/w/main',
						dirs: [],
						isPinned: false,
					},
				],
			});

			const fake = createFakeQuery({ holdTurns: true, sideReply });
			const manager = new SessionManager({
				...connectStore(store),
				registryFile: join(mkdtempSync(join(tmpdir(), 'voiceos-mgr-')), 'sessions.json'),
				home: '/h',
				fetchOrientation: () => Promise.resolve('## crew'),
				runQuery: fake.runQuery,
			});

			store.onEffect(manager.handle);

			return { store, manager, fake };
		};

		const asideOf = (store: Store) =>
			store.state.sessions['store-front/main']?.stream.find((item) => item.kind === 'aside');

		const askWhileWorking = async ({ store }: { store: Store }) => {
			store.dispatch({ type: 'activate', ref: 'store-front/main' });
			await waitTick();
			store.dispatch({ type: 'send', ref: 'store-front/main', text: 'refactor the router' });
			await waitTick();
			store.dispatch({ type: 'send', ref: 'store-front/main', text: 'which file?', aside: true });
			await waitTick();
		};

		it('answered → a fork of the running conversation answers, and the item holds it', async () => {
			const harness = createAsideHarness([
				{ type: 'assistant', message: { content: [{ type: 'text', text: 'The router.' }] } },
				{ type: 'result', subtype: 'success' },
			]);

			await askWhileWorking(harness);

			expect(harness.fake.forks).toEqual([
				expect.objectContaining({ resume: 's-1', forkSession: true, cwd: '/w/main' }),
			]);
			expect(asideOf(harness.store)).toMatchObject({ status: 'answered', answer: 'The router.' });
			expect(harness.store.state.sessions['store-front/main']?.queue).toEqual([]);
			harness.manager.stopAll();
		});

		it('the fork throws → failed, and the question waits in the queue', async () => {
			const harness = createAsideHarness(new Error('resume refused'));

			await askWhileWorking(harness);

			expect(asideOf(harness.store)).toMatchObject({ status: 'failed' });
			expect(harness.store.state.sessions['store-front/main']?.queue.map((m) => m.text)).toEqual([
				'which file?',
			]);
			harness.manager.stopAll();
		});

		it('a note with the question → the fork reads it first; failed, it waits beside the bare question', async () => {
			const harness = createAsideHarness(new Error('resume refused'));
			const { store } = harness;

			store.dispatch({ type: 'activate', ref: 'store-front/main' });
			await waitTick();
			store.dispatch({ type: 'send', ref: 'store-front/main', text: 'refactor the router' });
			await waitTick();
			store.dispatch({
				type: 'send',
				ref: 'store-front/main',
				text: 'which of my notes first?',
				aside: true,
				note: 'notes path',
			});
			await waitTick();

			expect(harness.fake.forkPrompts).toEqual([
				expect.stringMatching(/\n\nnotes path\n\nwhich of my notes first\?$/),
			]);
			expect(store.state.sessions['store-front/main']?.queue).toEqual([
				expect.objectContaining({ text: 'which of my notes first?', note: 'notes path' }),
			]);
			harness.manager.stopAll();
		});

		it('no running session → queued without forking', async () => {
			const harness = createAsideHarness([]);

			harness.manager.handle({
				type: 'side_answer',
				ref: 'store-front/main',
				itemId: 'x',
				question: 'which file?',
			});
			await waitTick();

			expect(harness.fake.forks).toEqual([]);
			expect(harness.store.state.sessions['store-front/main']?.queue.map((m) => m.text)).toEqual([
				'which file?',
			]);
		});
	});
});

describe('attached files', () => {
	const REF = 'store-front/main';

	const createAttachHarness = (options: FakeQueryParams = {}) => {
		const root = mkdtempSync(join(tmpdir(), 'voiceos-mgr-att-'));
		const attachmentsDir = join(root, 'attachments');
		const store = new Store();
		store.dispatch({
			type: 'worktrees',
			worktrees: [{ ref: REF, label: REF, branch: '', cwd: '/w/main', dirs: [], isPinned: false }],
		});
		const fake = createFakeQuery(options);
		const manager = new SessionManager({
			...connectStore(store),
			registryFile: join(root, 'sessions.json'),
			home: '/h',
			fetchOrientation: async () => '',
			runQuery: fake.runQuery,
			attachmentsDir,
		});
		store.onEffect(manager.handle);

		return { store, manager, fake, attachmentsDir, mediaDir: join(root, 'media') };
	};

	it('Claude reads where each file is, one a line, ahead of the words; a file not here is left out', async () => {
		const harness = createAttachHarness();
		const stored = storeAttachment({
			bytes: Buffer.from('trace'),
			name: 'trace, full.log',
			mediaType: 'text/plain',
			dir: harness.attachmentsDir,
			mediaDir: harness.mediaDir,
		});

		if (!stored.ok) {
			throw new Error('not stored');
		}

		const missing = { ...stored.attachment, id: '0123456789abcdef/gone.txt', name: 'gone.txt' };
		harness.store.dispatch({ type: 'activate', ref: REF });
		await waitTick();
		harness.store.dispatch({ type: 'attachment_added', ref: REF, attachment: stored.attachment });
		harness.store.dispatch({ type: 'attachment_added', ref: REF, attachment: missing });
		harness.store.dispatch({ type: 'send', ref: REF, text: 'why does it fail?' });
		await waitTick();

		const path = join(harness.attachmentsDir, ...stored.attachment.id.split('/'));
		expect(harness.fake.sent.at(-1)).toBe(`${describeAttached([path])}\n\nwhy does it fail?`);
		harness.manager.stopAll();
	});

	it('words with a note of their own → the note, then the files, then the words; none here → the note alone', async () => {
		const harness = createAttachHarness();
		const stored = storeAttachment({
			bytes: Buffer.from('a'),
			name: 'a.txt',
			mediaType: 'text/plain',
			dir: harness.attachmentsDir,
			mediaDir: harness.mediaDir,
		});

		if (!stored.ok) {
			throw new Error('not stored');
		}

		const path = join(harness.attachmentsDir, ...stored.attachment.id.split('/'));
		harness.store.dispatch({ type: 'activate', ref: REF });
		await waitTick();
		harness.store.dispatch({ type: 'attachment_added', ref: REF, attachment: stored.attachment });
		harness.store.dispatch({ type: 'send', ref: REF, text: 'one', note: '(N)' });
		await waitTick();
		harness.store.dispatch({ type: 'turn_ended', ref: REF, costUsd: 0, text: '' });
		harness.store.dispatch({
			type: 'attachment_added',
			ref: REF,
			attachment: { ...stored.attachment, id: '0123456789abcdef/gone.txt' },
		});
		harness.store.dispatch({ type: 'send', ref: REF, text: 'two', note: '(N)' });
		await waitTick();

		expect(harness.fake.sent.slice(-2)).toEqual([
			`(N)\n\n${describeAttached([path])}\n\none`,
			'(N)\n\ntwo',
		]);
		harness.manager.stopAll();
	});

	it('pieces from the main are put together into a file its worker then finds', async () => {
		const harness = createAttachHarness();
		const id = '0123456789abcdef/shot.png';

		await harness.manager.handle({
			type: 'attachment_chunk',
			ref: REF,
			id,
			index: 0,
			total: 1,
			base64: Buffer.from('png').toString('base64'),
		});

		expect(resolveAttachment(harness.attachmentsDir, id)).not.toBeNull();
	});
});

describe('slash commands', () => {
	const REF = 'store-front/main';
	const REVIEW = { name: 'review', description: 'Review a change', argumentHint: '<pr>' };
	const SHIP = { name: 'ship', description: 'Ship it', argumentHint: '' };

	const createCommandHarness = (options: FakeQueryParams = {}) => {
		const store = new Store();
		store.dispatch({
			type: 'worktrees',
			worktrees: [{ ref: REF, label: REF, branch: '', cwd: '/w/main', dirs: [], isPinned: false }],
		});
		const fake = createFakeQuery({ commands: [REVIEW], ...options });
		const manager = new SessionManager({
			...connectStore(store),
			registryFile: join(mkdtempSync(join(tmpdir(), 'voiceos-mgr-cmd-')), 'sessions.json'),
			home: '/h',
			fetchOrientation: async () => '',
			runQuery: fake.runQuery,
		});
		store.onEffect(manager.handle);
		store.dispatch({ type: 'activate', ref: REF });

		return { store, manager, fake };
	};

	const noticesOf = (store: Store) =>
		store.state.sessions[REF]?.stream.flatMap((item) =>
			item.kind === 'notice' ? [item.text] : [],
		);

	it('listed once it starts, and replaced when Claude Code pushes a new list', async () => {
		const harness = createCommandHarness();
		await waitTick();

		expect(harness.store.state.sessions[REF]?.commands).toEqual([REVIEW]);

		harness.fake.pushCommands([REVIEW, SHIP]);
		await waitTick();

		expect(harness.store.state.sessions[REF]?.commands).toEqual([REVIEW, SHIP]);
		harness.manager.stopAll();
	});

	it('/reload-plugins → reloaded, held on cache impact unless forced, and said in the stream', async () => {
		const harness = createCommandHarness({ holdReload: true });
		await waitTick();

		harness.store.dispatch({ type: 'reload_session', ref: REF, kind: 'plugins' });
		await waitTick();
		harness.store.dispatch({ type: 'reload_session', ref: REF, kind: 'plugins', force: true });
		await waitTick();

		expect(harness.fake.reloads).toEqual(['plugins:hold', 'plugins']);
		expect(noticesOf(harness.store)).toEqual([
			"Plugins not reloaded: it would change the session's tools and drop its cached context. Send /reload-plugins force to reload anyway.",
			'Plugins reloaded: 1 plugin, 1 command, 0 agents.',
		]);
		harness.manager.stopAll();
	});

	it('/reload-skills and /model → done live, said in the stream', async () => {
		const harness = createCommandHarness();
		await waitTick();

		harness.store.dispatch({ type: 'reload_session', ref: REF, kind: 'skills' });
		harness.store.dispatch({ type: 'set_model', ref: REF, model: 'opus' });
		await waitTick();

		expect(harness.fake.reloads).toEqual(['skills']);
		expect(harness.fake.models).toEqual(['opus']);
		expect(noticesOf(harness.store)).toEqual(['Skills reloaded: 1 skill.', 'Model: opus.']);
		harness.manager.stopAll();
	});

	it('a reload that applies, and a skills reload, refresh the menu', async () => {
		const harness = createCommandHarness({ reloadedCommands: [REVIEW, SHIP] });
		await waitTick();

		harness.store.dispatch({ type: 'reload_session', ref: REF, kind: 'plugins', force: true });
		await waitTick();

		expect(harness.store.state.sessions[REF]?.commands).toEqual([REVIEW, SHIP]);

		const skills = createCommandHarness({ reloadedCommands: [SHIP] });
		await waitTick();
		skills.store.dispatch({ type: 'reload_session', ref: REF, kind: 'skills' });
		await waitTick();

		expect(skills.store.state.sessions[REF]?.commands).toEqual([SHIP]);
		harness.manager.stopAll();
		skills.manager.stopAll();
	});

	it('a reload or a model that fails → said in the stream, never thrown', async () => {
		const harness = createCommandHarness({ controlError: new Error('boom') });
		await waitTick();

		harness.store.dispatch({ type: 'reload_session', ref: REF, kind: 'plugins', force: true });
		harness.store.dispatch({ type: 'set_model', ref: REF, model: 'opus' });
		await waitTick();

		expect(noticesOf(harness.store)).toEqual([
			'Could not reload plugins: Error: boom',
			'Could not switch to opus: Error: boom',
		]);
		harness.manager.stopAll();
	});

	it("rows sharing a name → Claude Code's own kept; long lists and texts cut", async () => {
		const mine = { name: 'review', description: 'Mine', argumentHint: '' };
		const builtin = { name: 'review', description: 'Built in', argumentHint: '', builtin: true };
		const many = Array.from({ length: 320 }, (_, index) => ({
			name: `c${index}`,
			description: 'd'.repeat(250),
			argumentHint: 'h'.repeat(100),
		}));
		const harness = createCommandHarness({ commands: [mine, builtin, ...many] });
		await waitTick();

		const listed = harness.store.state.sessions[REF]?.commands ?? [];

		expect(listed.filter((command) => command.name === 'review')).toEqual([
			{ name: 'review', description: 'Built in', argumentHint: '' },
		]);
		expect(listed).toHaveLength(300);
		expect(listed[1]?.description).toHaveLength(200);
		expect(listed[1]?.argumentHint).toHaveLength(80);
		harness.manager.stopAll();
	});
});

import { describe, expect, it } from 'bun:test';
import type { PendingAsk } from '../shared/protocol.js';
import { buildAsk, PermissionBridge } from './permissions.js';

const createBridge = () => {
	const opened: PendingAsk[] = [];
	const closed: string[] = [];
	const bridge = new PermissionBridge(
		(ask) => opened.push(ask),
		(askId) => closed.push(askId),
		() => 5,
	);

	return { bridge, opened, closed };
};

describe('buildAsk', () => {
	it('AskUserQuestion → question with parsed options', () => {
		const ask = buildAsk({
			id: 'a',
			ref: 'r',
			at: 1,
			toolName: 'AskUserQuestion',
			input: {
				questions: [
					{
						question: 'Which?',
						multiSelect: true,
						options: [{ label: 'A', description: 'first' }],
					},
				],
			},
			suggestions: [],
		});
		expect(ask).toMatchObject({
			kind: 'question',
			questions: [
				{ question: 'Which?', multiSelect: true, options: [{ label: 'A', description: 'first' }] },
			],
		});
	});

	it('ExitPlanMode → plan text', () => {
		expect(
			buildAsk({
				id: 'a',
				ref: 'r',
				at: 1,
				toolName: 'ExitPlanMode',
				input: { plan: '# Plan' },
				suggestions: [],
			}),
		).toMatchObject({
			kind: 'plan',
			plan: '# Plan',
		});
	});

	it('other tools → permission with a spoken summary', () => {
		expect(
			buildAsk({
				id: 'a',
				ref: 'r',
				at: 1,
				toolName: 'Bash',
				input: { command: 'rm -rf dist' },
				suggestions: [],
			}),
		).toMatchObject({
			kind: 'permission',
			summary: 'run rm -rf dist',
		});
	});

	it('malformed question input → empty lists, no throw', () => {
		expect(
			buildAsk({
				id: 'a',
				ref: 'r',
				at: 1,
				toolName: 'AskUserQuestion',
				input: { questions: 'nope' },
				suggestions: [],
			}),
		).toMatchObject({
			questions: [],
		});
	});
});

describe('PermissionBridge', () => {
	it('answer → resolves the SDK promise once and reports close', async () => {
		const { bridge, opened, closed } = createBridge();
		const pending = bridge.canUseTool('store/main')('Bash', { command: 'ls' }, {});
		const askId = opened[0]?.id ?? '';

		expect(bridge.answer(askId, { behavior: 'allow', updatedInput: { command: 'ls' } })).toBe(true);
		expect(await pending).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
		expect(closed).toEqual([askId]);
	});

	it('second answer for the same id → false, first result kept', async () => {
		const { bridge, opened } = createBridge();
		const pending = bridge.canUseTool('store/main')('Bash', {}, {});
		const askId = opened[0]?.id ?? '';

		bridge.answer(askId, { behavior: 'deny', message: 'no' });

		expect(bridge.answer(askId, { behavior: 'allow', updatedInput: {} })).toBe(false);
		expect(await pending).toEqual({ behavior: 'deny', message: 'no' });
	});

	it('abort signal → denied, never hangs', async () => {
		const { bridge } = createBridge();
		const controller = new AbortController();
		const pending = bridge.canUseTool('store/main')('Bash', {}, { signal: controller.signal });

		controller.abort();

		expect(await pending).toEqual({ behavior: 'deny', message: 'Cancelled.' });
		expect(bridge.countPending()).toBe(0);
	});

	it('settleRef → denies only that session’s asks', async () => {
		const { bridge } = createBridge();
		const mine = bridge.canUseTool('store/main')('Bash', {}, {});

		bridge.canUseTool('store/wrk1')('Bash', {}, {});

		expect(bridge.settleRef('store/main', 'stopped')).toBe(1);
		expect(await mine).toEqual({ behavior: 'deny', message: 'stopped' });
		expect(bridge.countPending()).toBe(1);
	});
});

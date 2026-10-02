import { describe, expect, it } from 'bun:test';
import { createToolContext } from '../../test/support/tool-context.js';
import { judgeNever } from '../../test/support/english-judge.js';
import type { SetupReply } from '../crew/api.js';
import type { SetupCommand } from '../crew/commands.js';
import { createSession } from '../state/reducer.js';
import type { State } from '../shared/protocol.js';
import { executeTool, type ToolContext } from './tools.js';

const CHAT = 'chat/3fa9c1';

const ran = (code: number, stdout = '', stderr = ''): SetupReply => ({
	kind: 'ran',
	result: { code, stdout, stderr },
});

const chatSession = (ref: string, label: string, status: 'idle' | 'running' = 'idle') => ({
	...createSession({
		ref,
		label,
		branch: '',
		cwd: '/Users/dev',
		dirs: [],
		isPinned: false,
		isChat: true,
	}),
	status,
});

const withCrew = (reply: SetupReply, patch: Partial<State> = {}) => {
	const { tools, actions } = createToolContext(patch);
	const calls: { machine: string; command: SetupCommand }[] = [];
	const context: ToolContext = {
		...tools,
		runCrewOn: async (machine, command) => {
			calls.push({ machine, command });

			return reply;
		},
	};

	return { context, actions, calls };
};

describe('new_session', () => {
	it('crew makes it on this machine, the new ref is activated, and Voice OS says it started', async () => {
		const { context, actions, calls } = withCrew(
			ran(0, '{"id":"3fa9c1","dir":"/Users/dev/notes"}'),
		);

		const result = await executeTool(
			'new_session',
			{ machine: null, folder: '~/notes', name: 'research' },
			{ ...context, utterance: 'start a new session called research in my notes folder' },
		);

		expect(calls).toEqual([
			{ machine: 'local', command: { type: 'chat_add', dir: '~/notes', name: 'research' } },
		]);
		expect(actions).toEqual([{ type: 'activate', ref: CHAT }]);
		expect(result.reply).toBe('Started research.');
	});

	it('on another machine → made there, its ref carries the machine', async () => {
		const { context, actions, calls } = withCrew(ran(0, '{"id":"3fa9c1"}'), {
			machines: {
				vm1: { id: 'vm1', host: 'dev@vm1', name: 'Build box', status: 'connected', detail: null },
			} as unknown as State['machines'],
		});

		const result = await executeTool(
			'new_session',
			{ machine: 'Build box', folder: null, name: null },
			{ ...context, utterance: 'new session on build box' },
		);

		expect(calls[0]).toEqual({ machine: 'vm1', command: { type: 'chat_add' } });
		expect(actions).toEqual([{ type: 'activate', ref: `vm1:${CHAT}` }]);
		expect(result.reply).toBe('Started a plain session on Build box.');
	});

	it("crew refuses (no such folder) → nothing activated, crew's reason for the kernel to say", async () => {
		const { context, actions } = withCrew(
			ran(1, '', 'Error: no folder /Users/dev/nowhere on this machine\n'),
		);

		const result = await executeTool(
			'new_session',
			{ machine: null, folder: '~/nowhere', name: null },
			context,
		);

		expect(result.ok).toBe(false);
		expect(result.content).toContain('no folder /Users/dev/nowhere on this machine');
		expect(actions).toEqual([]);
	});

	it('an unknown machine → refused before crew runs', async () => {
		const { context, calls } = withCrew(ran(0, '{"id":"3fa9c1"}'));

		const result = await executeTool(
			'new_session',
			{ machine: 'gpu box', folder: null, name: null },
			context,
		);

		expect(result.ok).toBe(false);
		expect(calls).toEqual([]);
	});
});

describe('remove_session', () => {
	const withChat = (status: 'idle' | 'running' = 'idle', reply = ran(0, '{"id":"3fa9c1"}')) => {
		const base = createToolContext().tools.getState();

		return withCrew(reply, {
			sessions: { ...base.sessions, [CHAT]: chatSession(CHAT, 'research', status) },
			order: [...base.order, CHAT],
			active: [...base.active, CHAT],
		});
	};

	it('named → stopped, then removed on its machine; the folder stays', async () => {
		const { context, actions, calls } = withChat();

		const result = await executeTool(
			'remove_session',
			{ ref: CHAT },
			{ ...context, utterance: 'remove research', judge: judgeNever },
		);

		expect(actions).toEqual([{ type: 'deactivate', ref: CHAT }]);
		expect(calls).toEqual([{ machine: 'local', command: { type: 'chat_rm', id: CHAT } }]);
		expect(result.reply).toBe('Removed research. Its folder stays.');
	});

	it('working → asked first; with force after a yes → removed', async () => {
		const asked = withChat('running');
		const first = await executeTool(
			'remove_session',
			{ ref: CHAT },
			{ ...asked.context, utterance: 'remove research', judge: judgeNever },
		);

		expect(first.ok).toBe(false);
		expect(first.content).toContain('is working');
		expect(asked.calls).toEqual([]);

		const forced = withChat('running');
		await executeTool(
			'remove_session',
			{ ref: CHAT, force: true },
			{ ...forced.context, utterance: 'yes remove research', judge: judgeNever },
		);

		expect(forced.calls).toHaveLength(1);
	});

	it('a worktree → never removed by voice', async () => {
		const { context, actions, calls } = withChat();

		const result = await executeTool(
			'remove_session',
			{ ref: 'store-front/main' },
			{ ...context, utterance: 'remove store front main' },
		);

		expect(result.ok).toBe(false);
		expect(result.content).toContain('worktree');
		expect(actions).toEqual([]);
		expect(calls).toEqual([]);
	});

	it('not named in the words → asked which, nothing stopped', async () => {
		const { context, actions } = withChat();

		const result = await executeTool(
			'remove_session',
			{ ref: CHAT },
			{ ...context, utterance: 'remove that one', judge: judgeNever },
		);

		expect(result.ok).toBe(false);
		expect(actions).toEqual([]);
	});
});

import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CrewAdapter } from '../crew/adapter.js';
import { configureLog } from '../log.js';
import type { SessionManager } from '../sessions/manager.js';
import { Store } from '../state/store.js';
import { until } from '../../test/support/link.js';
import { connectMachines, toMachinesArgs } from './cockpit-machines.js';

configureLog({ quiet: true });

describe('toMachinesArgs', () => {
	it.each([
		[
			{ kind: 'add' as const, host: 'dev@vm1', name: 'Build box' },
			['voice', 'machines', 'add', 'dev@vm1', '--name=Build box'],
		],
		[
			{ kind: 'rename' as const, id: 'vm1', name: 'GPU box' },
			['voice', 'machines', 'rename', 'vm1', 'GPU box'],
		],
		[{ kind: 'remove' as const, id: 'vm1' }, ['voice', 'machines', 'rm', 'vm1']],
	])('%p → crew %p', (change, args) => {
		expect(toMachinesArgs(change)).toEqual(args);
	});
});

describe('connectMachines', () => {
	it('crew refuses a change → the reason said aloud, and the machines go back to what the file holds', async () => {
		const said: string[] = [];
		const store = new Store();
		const machines = connectMachines({
			store,
			voiceDir: mkdtempSync(join(tmpdir(), 'voiceos-cockpit-')),
			home: '/h',
			mediaDir: '/h/media',
			crew: { listWorktrees: async () => [] } as unknown as CrewAdapter,
			runCrew: async () => ({
				code: 1,
				stdout: '',
				stderr: 'Error: vm1 already connects to vm1\n',
			}),
			manager: { handle: () => undefined, listRunning: () => [] } as unknown as SessionManager,
			say: (text) => said.push(text),
			sayLine: () => undefined,
			onStatusesChanged: () => undefined,
			// Never a real SSH login from a test.
			open: () => ({ write: () => undefined, close: () => undefined }),
		});

		try {
			store.dispatch({ type: 'add_machine', host: 'vm1', name: 'Build box' });
			await until(() => said.length > 0, 'the refusal said');

			expect(said).toEqual([
				'That change to your machines was not saved: vm1 already connects to vm1.',
			]);
			expect(store.state.machines).toEqual({});
		} finally {
			machines.stop();
		}
	});
});

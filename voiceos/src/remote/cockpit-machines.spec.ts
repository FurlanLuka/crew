import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CrewAdapter } from '../crew/adapter.js';
import { configureLog } from '../log.js';
import type { SessionManager } from '../sessions/manager.js';
import type { WorktreeInfo } from '../shared/protocol.js';
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
			secretsDir: '/h/secrets',
			attachmentsDir: '/h/attachments',
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

	it('Set up\'s "Open Voice OS" on a worktree not listed yet → the real refresh lists it, then it is activated and shown', async () => {
		const store = new Store();
		const worktree = (ref: string, isPinned = false): WorktreeInfo => ({
			ref,
			label: ref,
			branch: isPinned ? '' : `crew/${ref}`,
			cwd: isPinned ? '/h' : `/w/${ref}`,
			dirs: [],
			isPinned,
		});
		const machines = connectMachines({
			store,
			voiceDir: mkdtempSync(join(tmpdir(), 'voiceos-cockpit-')),
			home: '/h',
			mediaDir: '/h/media',
			secretsDir: '/h/secrets',
			attachmentsDir: '/h/attachments',
			crew: {
				listWorktrees: async () => [worktree('setup', true), worktree('checkout-api/main')],
			} as unknown as CrewAdapter,
			runCrew: async () => ({ code: 0, stdout: '', stderr: '' }),
			manager: { handle: () => undefined, listRunning: () => [] } as unknown as SessionManager,
			say: () => undefined,
			sayLine: () => undefined,
			onStatusesChanged: () => undefined,
			open: () => ({ write: () => undefined, close: () => undefined }),
		});

		try {
			expect(store.state.sessions['checkout-api/main']).toBeUndefined();
			store.dispatch({ type: 'activate', ref: 'checkout-api/main', open: true });
			await until(() => store.state.active.includes('checkout-api/main'), 'activated');

			expect(store.state.view).toEqual({
				kind: 'session',
				ref: 'checkout-api/main',
				from: 'active',
			});
		} finally {
			machines.stop();
		}
	});
});

describe('a secret copy arriving on the main', () => {
	const setup = () => {
		const root = mkdtempSync(join(tmpdir(), 'voiceos-secret-in-'));
		const store = new Store();
		const machines = connectMachines({
			store,
			voiceDir: root,
			home: '/h',
			mediaDir: join(root, 'media'),
			secretsDir: join(root, 'secrets'),
			attachmentsDir: join(root, 'attachments'),
			crew: { listWorktrees: async () => [] } as unknown as CrewAdapter,
			runCrew: async () => ({ code: 0, stdout: '', stderr: '' }),
			manager: { handle: () => undefined, listRunning: () => [] } as unknown as SessionManager,
			say: () => undefined,
			sayLine: () => undefined,
			onStatusesChanged: () => undefined,
			open: () => ({ write: () => undefined, close: () => undefined }),
		});
		const transferred: unknown[] = [];

		store.subscribe((stamped) => {
			if (stamped.input.type === 'secret_transferred') {
				transferred.push(stamped.input);
			}
		});

		return { root, store, machines, transferred };
	};

	const allowedRequest = {
		id: 's1',
		kind: 'secret' as const,
		from: 'store-front/main',
		to: 'vm1:checkout-api/main',
		at: 1,
	};
	const copy = { id: 's1', toRef: 'store-front/main', name: 'K.env', bytes: Buffer.from('K=v\n') };

	it('one the developer allowed, from the machine it was asked of → written here, only its path said', () => {
		const { root, store, machines, transferred } = setup();

		try {
			store.state.peerRequests.push(allowedRequest);
			machines.deliverSecret({ ...copy, source: 'vm1' });

			const path = join(root, 'secrets', 'store-front_main', 's1', 'K.env');

			expect(readFileSync(path, 'utf8')).toBe('K=v\n');
			expect(transferred).toEqual([
				{ type: 'secret_transferred', ref: 'store-front/main', id: 's1', path },
			]);
		} finally {
			machines.stop();
		}
	});

	it('nothing allowed it, or it came from another machine → dropped, nothing written', () => {
		const { root, store, machines, transferred } = setup();

		try {
			machines.deliverSecret({ ...copy, source: 'vm1' });
			store.state.peerRequests.push(allowedRequest);
			machines.deliverSecret({ ...copy, source: 'vm2' });

			expect(transferred).toEqual([]);
			expect(existsSync(join(root, 'secrets'))).toBe(false);
		} finally {
			machines.stop();
		}
	});
});

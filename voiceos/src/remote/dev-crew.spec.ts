import { describe, expect, it } from 'bun:test';
import { createRemoteDevCrew } from './dev-crew.js';

describe('createRemoteDevCrew', () => {
	it('refs lose the machine on the way out and routes gain it on the way back', async () => {
		const calls: string[][] = [];
		const crew = createRemoteDevCrew('vm1', async (args) => {
			calls.push(args);

			return {
				code: 0,
				stdout:
					args[1] === 'status'
						? JSON.stringify([
								{ worktree: 'store/main', server_name: 'api', url: 'http://localhost:3000' },
							])
						: '[]',
				stderr: '',
			};
		});

		const routes = await crew.readDevRoutes();

		await crew.checkServers('vm1:store/main');

		expect(routes).toMatchObject([{ worktree: 'vm1:store/main', server_name: 'api' }]);
		expect(calls).toEqual([
			['dev', 'status', '--json'],
			['dev', 'check', 'store/main', '--json'],
		]);
	});
});

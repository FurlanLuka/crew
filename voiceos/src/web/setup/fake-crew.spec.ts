// The fake crew builds some reads itself (from its state, so mutations show): each must have the
// shape crew prints. Compared key path by key path with the Go-written golden of the same read, so a
// field crew adds, renames or drops fails here before a page test passes on a stale shape.
import { describe, expect, it } from 'bun:test';
import type { SetupCommand } from '../../crew/commands.js';
import { LOCAL_MACHINE } from '../../shared/machine-ref.js';
import { createFakeCrew, readGolden } from '../../../test/support/fake-crew.js';

// Every key path in a document, arrays read as one element made of all of theirs ("[].steps[].name").
const keyPaths = (value: unknown, at = ''): string[] => {
	if (Array.isArray(value)) {
		return [...new Set(value.flatMap((item) => keyPaths(item, `${at}[]`)))].sort();
	}

	if (value && typeof value === 'object') {
		return Object.entries(value)
			.flatMap(([key, child]) => {
				const path = at ? `${at}.${key}` : key;

				return [path, ...keyPaths(child, path)];
			})
			.sort();
	}

	return [];
};

const BUNDLE = JSON.stringify({
	version: 2,
	projects: [
		{ name: 'store-front', remote: 'git@github.com:example/store-front.git' },
		{ name: 'store-api', remote: 'git@github.com:example/store-api.git' },
		{ name: 'checkout-api', remote: 'git@github.com:example/checkout-api.git' },
		{ name: 'infra-ops' },
	],
	workspaces: [
		{ name: 'store-front', projects: [{ name: 'store-api', mode: 'worktree' }] },
		{ name: 'admin', projects: [{ name: 'checkout-api', mode: 'worktree' }] },
	],
});

// The fake's own reads, each beside the golden crew wrote for the same read.
const BUILT: [string, SetupCommand, number?][] = [
	['ls-workspaces.json', { type: 'ls_workspaces' }],
	['ls-worktrees-setup.json', { type: 'ls_worktrees', size: true }],
	['show-worktree.json', { type: 'show', ref: 'store-front/main' }],
	['ls-bases.json', { type: 'ls_bases', workspace: 'store-front' }],
	['scan-checkouts.json', { type: 'scan_checkouts' }],
	['check-status-failed.json', { type: 'check_status', project: 'store-api' }],
	['check-status-none.json', { type: 'check_status', project: 'signals' }],
	['trash.json', { type: 'trash' }],
	['import-plan.json', { type: 'import_plan', bundle: BUNDLE }],
	['rm-worktree-dry-run.json', { type: 'rm_worktree_dry_run', ref: 'store-front/wrk1' }],
	['rm-worktree-dry-run-last.json', { type: 'rm_worktree_dry_run', ref: 'admin/main' }],
	['server-machines.json', { type: 'machines_ls' }],
	['server-discord-status.json', { type: 'discord_status' }],
	['ls-chats.json', { type: 'ls_chats' }],
	['migrate.json', { type: 'migrate', confirm: true }],
];

const readJson = async (
	command: SetupCommand,
	seed: 'golden' | 'empty' = 'golden',
): Promise<unknown> => {
	const crew = createFakeCrew({ runMs: 0, seed });
	const reply = await crew.runCrew(LOCAL_MACHINE, command);

	if (reply.kind !== 'ran') {
		throw new Error(`${command.type}: ${reply.kind}`);
	}

	return JSON.parse(reply.result.stdout) as unknown;
};

describe('the fake crew answers in crew’s shapes', () => {
	it.each(BUILT)('%s ← %j', async (golden, command) => {
		expect(keyPaths(await readJson(command))).toEqual(keyPaths(readGolden(golden)));
	});

	it('a pre-2.0 workspace: crew migrate --dry-run moves, as crew prints them', async () => {
		const crew = createFakeCrew({ runMs: 0 });
		const local = crew.machines[LOCAL_MACHINE];

		if (!local) {
			throw new Error('no local machine');
		}

		local.flatWorkspaces = ['legacy-shop'];
		const reply = await crew.runCrew(LOCAL_MACHINE, { type: 'migrate_dry_run' });

		if (reply.kind !== 'ran') {
			throw new Error(reply.kind);
		}

		expect(keyPaths(JSON.parse(reply.result.stdout))).toEqual(
			keyPaths(readGolden('migrate-dry-run.json')),
		);
	});

	it('a first run: no other machines, Discord never set up — as crew says them', async () => {
		expect(await readJson({ type: 'machines_ls' }, 'empty')).toEqual(
			readGolden('server-machines-empty.json'),
		);
		expect(keyPaths(await readJson({ type: 'discord_status' }, 'empty'))).toEqual(
			keyPaths(readGolden('server-discord-off.json')),
		);
		expect(await readJson({ type: 'ls_bases', workspace: 'store-front' }, 'empty')).toEqual(
			readGolden('ls-bases-empty.json'),
		);
	});

	it('a setup run, start to verdict: the keys of crew setup status at each stage', async () => {
		let clock = 1_000_000;
		const crew = createFakeCrew({ runMs: 300, now: () => clock });

		const status = async (ref: string) => {
			const reply = await crew.runCrew(LOCAL_MACHINE, { type: 'setup_status', ref });

			return reply.kind === 'ran' ? (JSON.parse(reply.result.stdout) as unknown) : null;
		};

		expect(keyPaths(await status('store-front/main'))).toEqual(
			keyPaths(readGolden('setup-status-none.json')),
		);

		crew.failInstall('store-api');
		await crew.runCrew(LOCAL_MACHINE, { type: 'add_worktree', ref: 'store-front/wrk2' });
		// Halfway: a project's first step done, its next one running.
		clock += 150;
		expect(keyPaths(await status('store-front/wrk2'))).toEqual(
			keyPaths(readGolden('setup-status-starting.json')),
		);
		clock += 200;
		expect(keyPaths(await status('store-front/wrk2'))).toEqual(
			keyPaths(readGolden('setup-status-failed.json')),
		);

		await crew.runCrew(LOCAL_MACHINE, { type: 'add_worktree', ref: 'store-front/wrk3' });
		clock += 300;
		expect(keyPaths(await status('store-front/wrk3'))).toEqual(
			keyPaths(readGolden('setup-status-ok.json')),
		);
	});

	it('a check, start to pass: the keys of crew check status', async () => {
		let clock = 1_000_000;
		const crew = createFakeCrew({ runMs: 300, now: () => clock });

		await crew.runCrew(LOCAL_MACHINE, { type: 'check_project', project: 'store-api' });
		clock += 300;
		const reply = await crew.runCrew(LOCAL_MACHINE, { type: 'check_status', project: 'store-api' });

		expect(reply.kind === 'ran' && keyPaths(JSON.parse(reply.result.stdout))).toEqual(
			keyPaths(readGolden('check-status-passed.json')),
		);
	});
});

describe('keyPaths', () => {
	it('objects, arrays of objects merged, nothing for a plain value', () => {
		expect(keyPaths({ a: 1, b: [{ c: 1 }, { d: { e: 2 } }] })).toEqual([
			'a',
			'b',
			'b[].c',
			'b[].d',
			'b[].d.e',
		]);
		expect(keyPaths('x')).toEqual([]);
	});
});

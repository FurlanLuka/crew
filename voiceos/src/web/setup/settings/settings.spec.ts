import { describe, expect, it } from 'bun:test';
import { readGolden } from '../../../../test/support/fake-crew.js';
import {
	type UpdateCheck,
	countLeftovers,
	countRows,
	describeLeftovers,
	describeTrust,
	describeUpdate,
	CONFIG_FIELDS,
	planConfigSave,
	showConfigValue,
} from './settings.js';

describe('describeUpdate', () => {
	const lines =
		readGolden<Record<'update_offline' | 'update_dev' | 'update_current', string>>(
			'crew-lines.json',
		);

	it('crew update --check --json goldens → a release to install, or the line crew prints', () => {
		expect(describeUpdate(readGolden<UpdateCheck>('update-check.json'))).toEqual({
			kind: 'available',
			current: '4.1.0',
			latest: '4.2.0',
		});
		expect(describeUpdate(readGolden<UpdateCheck>('update-check-offline.json'))).toEqual({
			kind: 'line',
			text: lines.update_offline,
		});
		expect(describeUpdate(readGolden<UpdateCheck>('update-check-dev.json'))).toEqual({
			kind: 'line',
			text: lines.update_dev,
		});
		expect(describeUpdate(readGolden<UpdateCheck>('update-check-current.json'))).toEqual({
			kind: 'line',
			text: lines.update_current,
		});
	});

	it("anything but a release to install → crew's own line, word for word", () => {
		expect(
			describeUpdate({
				current: 'dev',
				latest: '4.2.0',
				available: false,
				line: 'crew (dev build) — x',
			}),
		).toEqual({ kind: 'line', text: 'crew (dev build) — x' });
		expect(
			describeUpdate({
				current: '4.1.0',
				available: true,
				latest: '4.2.0',
				error: 'offline',
				line: 'l',
			}),
		).toEqual({ kind: 'line', text: 'l' });
	});

	it('nothing read yet → nothing shown', () => {
		expect(describeUpdate({})).toBeNull();
	});
});

describe('planConfigSave', () => {
	const CONFIG = readGolden<Record<string, unknown>>('config-show.json');

	it('only the fields edited away from what crew has', () => {
		const domain = String(CONFIG.domain ?? '');

		expect(planConfigSave(CONFIG, { domain, server_ip: '10.0.0.9' })).toEqual([
			{ type: 'config_set', key: 'server_ip', value: '10.0.0.9' },
		]);
		expect(planConfigSave(CONFIG, {})).toEqual([]);
	});

	it('a port at its default reads empty; emptied, it saves 0 (the default), and untouched saves nothing', () => {
		const config = { proxy_port: 0, proxy_https_port: 8443 };

		expect(planConfigSave(config, { proxy_port: '' })).toEqual([]);
		expect(planConfigSave(config, { proxy_https_port: '' })).toEqual([
			{ type: 'config_set', key: 'proxy_https_port', value: '0' },
		]);
		expect(planConfigSave(config, { proxy_https_port: '-1' })).toEqual([
			{ type: 'config_set', key: 'proxy_https_port', value: '-1' },
		]);
	});
});

describe('showConfigValue', () => {
	const field = (key: string) => CONFIG_FIELDS.find((candidate) => candidate.key === key)!;

	it.each([
		['proxy_port', { proxy_port: 0 }, ''],
		['proxy_port', { proxy_port: 8080 }, '8080'],
		['proxy_https_port', { proxy_https_port: 0 }, ''],
		['proxy_https_port', {}, ''],
		['proxy_https_port', { proxy_https_port: -1 }, '-1'],
		['domain', { domain: 'dev.example.com' }, 'dev.example.com'],
	] as const)('%s %j → %j', (key, config, want) => {
		expect(showConfigValue(field(key), config)).toBe(want);
	});
});

describe('countLeftovers', () => {
	it('prune rows → not counted: crew lists one per repo whether or not git has anything to prune', () => {
		expect(
			countLeftovers([
				{ kind: 'prune', path: '/r/a' },
				{ kind: 'prune', path: '/r/b' },
			]),
		).toBe(0);
		expect(
			countLeftovers([
				{ kind: 'prune', path: '/r/a' },
				{ kind: 'check', path: '/c/x' },
				{ kind: 'logs', path: '/l/y' },
			]),
		).toBe(2);
		expect(countLeftovers(readGolden('clean-dry-run.json'))).toBe(3);
		expect(countLeftovers(null)).toBe(0);
	});
});

describe('countRows', () => {
	it('crew migrate --dry-run --json → its moves; anything else → 0', () => {
		expect(countRows(readGolden('migrate-dry-run.json'))).toBe(1);
		expect(countRows([])).toBe(0);
		expect(countRows({ workspace: 'store-front' })).toBe(0);
		expect(countRows(null)).toBe(0);
	});
});

describe('describeLeftovers', () => {
	it('crew clean --dry-run --json → what each thing is and where', () => {
		expect(describeLeftovers(readGolden('clean-dry-run.json'))).toEqual([
			'an old check: /Users/dev/.crew/checks/store-api.json',
			'logs of a removed worktree: /Users/dev/.crew/logs/old-ws--main',
			'the trash: /Users/dev/.crew/trash',
		]);
	});

	it('prune rows → left out, the same rule as the count', () => {
		expect(
			describeLeftovers([
				{ kind: 'prune', path: '/r/a' },
				{ kind: 'check', path: '/c/x.json' },
			]),
		).toEqual(['an old check: /c/x.json']);
	});
});

describe('describeTrust', () => {
	it("the CA's address for the other device, with its fingerprint", () => {
		expect(
			describeTrust({ pem_url: 'http://192.168.1.20/crew-ca.pem', fingerprint: 'AB:CD' }),
		).toBe(
			"On the other device, open http://192.168.1.20/crew-ca.pem and trust crew's certificate (fingerprint AB:CD).",
		);
		expect(describeTrust({})).toBeNull();
	});
});

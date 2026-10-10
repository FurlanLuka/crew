import { describe, expect, it } from 'bun:test';
import { initialTabKey, type LogTabTarget } from './logs-tab.js';

const TABS: LogTabTarget[] = [
	{ key: 'server web', project: 'store-front', server: 'web' },
	{ key: 'server api', project: 'store-api', server: 'api' },
	{ key: 'server worker', project: 'store-api', server: 'worker' },
	{ key: 'setup store-front', project: 'store-front' },
	{ key: 'setup store-api', project: 'store-api' },
];

describe('initialTabKey', () => {
	it.each([
		['?tab=server:store-api/worker', 'server worker'],
		['?tab=server%3Astore-front%2Fweb', 'server web'],
		['?on=vm1&tab=setup:store-api', 'setup store-api'],
		// The server name decides; a project crew no longer pairs with it still finds it.
		['?tab=server:checkout-api/api', 'server api'],
		['?tab=server:api', 'server api'],
	])('%s → %s', (search, key) => expect(initialTabKey(search, TABS)).toBe(key));

	it.each([
		[''],
		['?on=vm1'],
		['?tab=server:store-front/admin'],
		['?tab=setup:admin'],
		['?tab=setup:'],
		['?tab=web'],
		['?tab=logs:store-front'],
	])('%s → none (the first tab)', (search) => expect(initialTabKey(search, TABS)).toBeNull());

	it('two members with a server of the same name: the one whose project matches', () => {
		const tabs: LogTabTarget[] = [
			{ key: 'server web#1', project: 'store-front', server: 'web' },
			{ key: 'server web#2', project: 'admin', server: 'web' },
		];

		expect(initialTabKey('?tab=server:admin/web', tabs)).toBe('server web#2');
		expect(initialTabKey('?tab=server:store-front/web', tabs)).toBe('server web#1');
	});

	it('no tabs yet (still reading): none', () =>
		expect(initialTabKey('?tab=setup:store-front', [])).toBeNull());
});

import { describe, expect, it } from 'bun:test';
import { nameFromPath, nameFromUrl } from './AddProject.js';

describe('the name a new project gets when none is typed', () => {
	it.each([
		['https://github.com/acme/store-api', 'store-api'],
		['https://github.com/acme/store-api.git/', 'store-api'],
		['git@github.com:acme/store-front.git', 'store-front'],
		['  ', ''],
	])('url %p → %p', (url, name) => {
		expect(nameFromUrl(url)).toBe(name);
	});

	it.each([
		['/Users/dev/code/signals', 'signals'],
		['~/code/admin/', 'admin'],
	])('path %p → %p', (path, name) => {
		expect(nameFromPath(path)).toBe(name);
	});
});

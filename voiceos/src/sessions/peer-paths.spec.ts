import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	checkSharedPath,
	isSecretPath,
	isSecretPattern,
	resolveInsideRoots,
} from './peer-paths.js';

const roots = { cwd: '/w/checkout', dirs: ['/w/shared'] };

describe('isSecretPath', () => {
	it.each([
		'.env',
		'.env.local',
		'app/.env.production',
		'certs/server.pem',
		'deploy/api.key',
		'id_rsa',
		'/home/dev/.ssh/config',
		'.npmrc',
		'.netrc',
		'aws-credentials.json',
		'client_secret.txt',
		'keystore.p12',
	])('%s → secret', (path) => expect(isSecretPath(path)).toBe(true));

	it.each(['src/payments/retry.ts', 'README.md', 'docs/keys.md', 'src/env.ts'])(
		'%s → not a secret',
		(path) => expect(isSecretPath(path)).toBe(false),
	);

	// A template is denied too: the copy cannot tell a filled-in one from it.
	it('.env.example → treated as a secret', () => expect(isSecretPath('.env.example')).toBe(true));
});

describe('resolveInsideRoots', () => {
	it('a relative path inside the worktree → its absolute path', () =>
		expect(resolveInsideRoots('src/a.ts', roots)).toBe('/w/checkout/src/a.ts'));

	it('an extra folder of the session counts as its own', () =>
		expect(resolveInsideRoots('/w/shared/x.sql', roots)).toBe('/w/shared/x.sql'));

	it('a way out with .. or an absolute path elsewhere → outside', () => {
		expect(resolveInsideRoots('../store-front/a.ts', roots)).toBeNull();
		expect(resolveInsideRoots('/etc/passwd', roots)).toBeNull();
		expect(resolveInsideRoots('/w/checkout-old/a.ts', roots)).toBeNull();
	});
});

describe('checkSharedPath', () => {
	it('inside and not a secret → shared', () =>
		expect(checkSharedPath('db/schema.sql', roots)).toEqual({
			ok: true,
			path: '/w/checkout/db/schema.sql',
		}));

	it('a secret inside → refused, pointing at request_secret', () =>
		expect(checkSharedPath('.env', roots)).toEqual({
			ok: false,
			reason: '.env looks like a secret; use request_secret',
		}));

	it('outside → refused', () =>
		expect(checkSharedPath('/tmp/x', roots)).toEqual({
			ok: false,
			reason: "/tmp/x is outside the session's folders",
		}));
});

describe('isSecretPattern', () => {
	it.each(['.env*', '**/.env.*', '*.pem', '{src,.ssh}/**', '**/*credential*'])(
		'%s → could list secrets',
		(glob) => expect(isSecretPattern(glob)).toBe(true),
	);

	it.each(['*.ts', 'src/**/*.go', '**/README.md'])('%s → safe', (glob) =>
		expect(isSecretPattern(glob)).toBe(false),
	);
});

describe('a symlink inside the worktree', () => {
	const made: string[] = [];

	afterEach(() => {
		for (const dir of made.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('pointing outside, or at a secret → judged by where it leads', () => {
		const home = mkdtempSync(join(tmpdir(), 'peer-paths-'));
		const cwd = join(home, 'checkout');

		made.push(home);
		mkdirSync(cwd);
		mkdirSync(join(home, '.ssh'));
		writeFileSync(join(home, '.ssh', 'id_ed25519'), 'key');
		writeFileSync(join(cwd, '.env'), 'A=1');
		symlinkSync(join(home, '.ssh', 'id_ed25519'), join(cwd, 'notes.txt'));
		symlinkSync(join(cwd, '.env'), join(cwd, 'config.txt'));

		expect(checkSharedPath('notes.txt', { cwd, dirs: [] })).toMatchObject({ ok: false });
		expect(checkSharedPath('config.txt', { cwd, dirs: [] })).toMatchObject({
			ok: false,
			reason: 'config.txt looks like a secret; use request_secret',
		});
	});
});

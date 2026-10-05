import { afterEach, describe, expect, it } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSecret, removeSessionSecrets, sweepSecrets, writeSecretFile } from './secrets.js';

const made: string[] = [];
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), 'secrets-'));

	made.push(dir);

	return dir;
};

afterEach(() => {
	for (const dir of made.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe('readSecret', () => {
	it('an env name → its line from .env, ready to source; .env.local when .env lacks it', () => {
		const cwd = scratch();

		writeFileSync(join(cwd, '.env'), 'A=1\nexport STRIPE_KEY = sk_live_x \n');
		writeFileSync(join(cwd, '.env.local'), 'ONLY_LOCAL=yes\n');

		const stripe = readSecret('STRIPE_KEY', { cwd, dirs: [] });
		const local = readSecret('ONLY_LOCAL', { cwd, dirs: [] });

		expect(stripe.ok && stripe.name).toBe('STRIPE_KEY.env');
		expect(stripe.ok && stripe.bytes.toString()).toBe('STRIPE_KEY=sk_live_x\n');
		expect(local.ok && local.bytes.toString()).toBe('ONLY_LOCAL=yes\n');
	});

	it('a file in its folders → its bytes; missing, outside or not a file → why not', () => {
		const cwd = scratch();

		mkdirSync(join(cwd, 'certs'));
		writeFileSync(join(cwd, 'certs', 'api.pem'), 'PEM');

		const pem = readSecret('certs/api.pem', { cwd, dirs: [] });

		expect(pem.ok && [pem.name, pem.bytes.toString()]).toEqual(['api.pem', 'PEM']);
		expect(readSecret('NOPE', { cwd, dirs: [] })).toEqual({
			ok: false,
			reason: "NOPE is not in the session's .env files",
		});
		expect(readSecret('/etc/hosts', { cwd, dirs: [] })).toEqual({
			ok: false,
			reason: "/etc/hosts is outside the session's folders",
		});
		expect(readSecret('certs/', { cwd, dirs: [] })).toEqual({
			ok: false,
			reason: 'certs/ is not a file',
		});
	});
});

describe('the temp file', () => {
	it('is readable only by its owner, in a folder only they can open', () => {
		const dir = scratch();
		const path = writeSecretFile({
			dir,
			ref: 'vm1:store-front/main',
			id: 'r-1',
			name: 'STRIPE_KEY.env',
			bytes: Buffer.from('STRIPE_KEY=x\n'),
		});

		expect(path).toBe(join(dir, 'vm1_store-front_main', 'r-1', 'STRIPE_KEY.env'));
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, 'vm1_store-front_main', 'r-1')).mode & 0o777).toBe(0o700);
	});

	it('goes when its session stops, and after a day whatever happens', () => {
		const dir = scratch();
		const write = (ref: string, id: string) =>
			writeSecretFile({ dir, ref, id, name: 'k', bytes: Buffer.from('k') });
		const kept = write('a/main', 'new');
		const old = write('a/main', 'old');
		const other = write('b/main', 'x');
		const dayAgo = (Date.now() - 25 * 60 * 60 * 1000) / 1000;

		utimesSync(join(dir, 'a_main', 'old'), dayAgo, dayAgo);

		expect(sweepSecrets(dir, Date.now())).toBe(1);
		expect([existsSync(kept), existsSync(old)]).toEqual([true, false]);

		removeSessionSecrets(dir, 'b/main');
		expect(existsSync(other)).toBe(false);
		expect(existsSync(kept)).toBe(true);
	});
});

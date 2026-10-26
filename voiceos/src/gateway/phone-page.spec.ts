import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../state/store.js';
import { configureLog } from '../log.js';
import { COOKIE_NAME, listAllowedOrigins } from './auth.js';
import { createPhones, createTailscaleHostReader, hashKey } from './phones.js';
import { REVOKED_CLOSE_CODE, startGateway, type Gateway } from './server.js';
import type { SetupCommand } from '../crew/commands.js';

configureLog({ quiet: true });

const TOKEN = 'a'.repeat(64);
const KEY = 'phone-key-0123456789abcdef';
const APP_HTML = '<!doctype html><html><head><title>Crew</title></head><body></body></html>';

let gateway: Gateway | null = null;

afterEach(() => {
	gateway?.stop();
	gateway = null;
});

const writePhones = (file: string, keys: string[]) =>
	writeFileSync(
		file,
		JSON.stringify({
			phones: keys.map((key, index) => ({
				id: `p${index + 1}`,
				name: 'Phone',
				key_sha256: hashKey(key).toString('hex'),
				created: '2026-10-26T10:00:00Z',
			})),
		}),
	);

const bootGateway = (ran: SetupCommand[] = []) => {
	const dir = mkdtempSync(join(tmpdir(), 'voiceos-phone-'));
	const phonesFile = join(dir, 'phones.json');
	const seenFile = join(dir, 'phones-seen.json');
	const tailscaleFile = join(dir, 'tailscale.json');
	const phones = createPhones({ phonesFile, seenFile });
	const readTailscaleHost = createTailscaleHostReader(tailscaleFile);

	writePhones(phonesFile, [KEY]);
	gateway = startGateway({
		store: new Store(),
		token: TOKEN,
		port: 0,
		index: new Response(APP_HTML, { headers: { 'content-type': 'text/html' } }),
		listAllowedOrigins: (port) =>
			listAllowedOrigins({
				port,
				proxyHost: null,
				proxyPort: null,
				tailscaleHost: readTailscaleHost(),
			}),
		findPhone: phones.findPhone,
		hasPhone: phones.hasPhone,
		recordPhoneSeen: phones.recordSeen,
		phoneSweepMs: 20,
		runCrew: async (_machine, command) => {
			ran.push(command);

			return { kind: 'ran', result: { code: 0, stdout: '[]', stderr: '' } };
		},
		onMessage: () => {},
		onAudio: () => {},
		readHealth: () => ({}),
	});

	return { port: gateway.port, phonesFile, seenFile, tailscaleFile };
};

const openSocket = (port: number, headers: Record<string, string>): Promise<WebSocket> =>
	new Promise((resolve, reject) => {
		const socket = new WebSocket(`ws://localhost:${port}/ws`, { headers } as unknown as string[]);

		socket.onopen = () => resolve(socket);
		socket.onerror = () => reject(new Error('rejected'));
	});

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)';

describe('phone sign-in', () => {
	it('a valid key → 200 with the app page, the phone head and the key as cookie', async () => {
		const { port, seenFile } = bootGateway();
		const response = await fetch(`http://localhost:${port}/phone/${KEY}`, {
			redirect: 'manual',
			headers: { 'user-agent': IPHONE },
		});
		const body = await response.text();
		const cookie = response.headers.get('set-cookie') ?? '';

		expect(response.status).toBe(200);
		expect(cookie).toContain(`${COOKIE_NAME}=${KEY}`);
		expect(cookie).toContain('HttpOnly');
		expect(cookie).not.toContain('Secure');
		expect(body).toContain(`<link rel="manifest" href="/phone/${KEY}/manifest.webmanifest">`);
		expect(body).toContain('window.__VOICEOS_PHONE__=true');
		expect(body.indexOf('__VOICEOS_PHONE__')).toBeLessThan(body.indexOf('</head>'));
		expect(body).toContain('<title>Crew</title>');
		expect(response.headers.get('referrer-policy')).toBe('no-referrer');
		expect(JSON.parse(readFileSync(seenFile, 'utf8')).p1.device).toBe('iPhone');
	});

	it('over https (forwarded) the cookie is Secure', async () => {
		const { port } = bootGateway();
		const response = await fetch(`http://localhost:${port}/phone/${KEY}`, {
			headers: { 'x-forwarded-proto': 'https' },
		});

		expect(response.headers.get('set-cookie')).toContain('; Secure');
	});

	it('/login over https (forwarded) sets a Secure cookie too', async () => {
		const { port } = bootGateway();
		const response = await fetch(`http://localhost:${port}/login?token=${TOKEN}`, {
			redirect: 'manual',
			headers: { 'x-forwarded-proto': 'https' },
		});

		expect(response.status).toBe(302);
		expect(response.headers.get('set-cookie')).toContain('; Secure');
	});

	it('removing a phone closes its open sockets with 4401, the token sockets stay open', async () => {
		const { port, phonesFile } = bootGateway();
		const origin = `http://localhost:${port}`;
		const phoneSocket = await openSocket(port, { origin, cookie: `${COOKIE_NAME}=${KEY}` });
		const tokenSocket = await openSocket(port, { origin, cookie: `${COOKIE_NAME}=${TOKEN}` });
		const closed = new Promise<number>((resolve) => {
			phoneSocket.onclose = (event) => resolve(event.code);
		});

		writePhones(phonesFile, []);
		expect(await closed).toBe(REVOKED_CLOSE_CODE);
		await Bun.sleep(60);
		expect(tokenSocket.readyState).toBe(WebSocket.OPEN);
		tokenSocket.close();
	});

	it('a phone may read phones and tailscale, never change them; the token may', async () => {
		const ran: SetupCommand[] = [];
		const { port } = bootGateway(ran);
		const post = (cookie: string, type: string) =>
			fetch(`http://localhost:${port}/api/crew`, {
				method: 'POST',
				headers: {
					origin: `http://localhost:${port}`,
					cookie: `${COOKIE_NAME}=${cookie}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					machine: 'local',
					command: type === 'phones_rm' ? { type, id: 'p1' } : { type },
				}),
			});

		for (const type of ['phones_add', 'phones_rm', 'tailscale_serve', 'tailscale_off']) {
			const refused = await post(KEY, type);

			expect(refused.status).toBe(403);
			expect(((await refused.json()) as { error: string }).error).toBe(
				'Manage phones and Tailscale from the Mac.',
			);
		}

		expect(ran).toEqual([]);
		expect((await post(KEY, 'phones_ls')).status).toBe(200);
		expect((await post(KEY, 'tailscale_status')).status).toBe(200);
		expect((await post(TOKEN, 'phones_add')).status).toBe(200);
		expect(ran.map((command) => command.type)).toEqual([
			'phones_ls',
			'tailscale_status',
			'phones_add',
		]);
	});

	it('an unknown or removed key → 401 page, no cookie', async () => {
		const { port, phonesFile } = bootGateway();
		const unknown = await fetch(`http://localhost:${port}/phone/nope`, { redirect: 'manual' });

		expect(unknown.status).toBe(401);
		expect(await unknown.text()).toContain("This link isn't valid any more.");
		expect(unknown.headers.get('set-cookie')).toBeNull();

		writePhones(phonesFile, []);
		const revoked = await fetch(`http://localhost:${port}/phone/${KEY}`, { redirect: 'manual' });

		expect(revoked.status).toBe(401);
	});

	it('the manifest starts the installed app at the phone link', async () => {
		const { port } = bootGateway();
		const response = await fetch(`http://localhost:${port}/phone/${KEY}/manifest.webmanifest`);
		const manifest = await response.json();

		expect(response.headers.get('content-type')).toContain('application/manifest+json');
		expect(manifest.start_url).toBe(`/phone/${KEY}`);
		expect(manifest.id).toBe(`/phone/${KEY}`);
		expect(manifest.scope).toBe('/');
		expect(manifest.display).toBe('standalone');
		expect(manifest.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual([
			'192x192',
			'512x512',
			'180x180',
		]);

		const refused = await fetch(`http://localhost:${port}/phone/nope/manifest.webmanifest`);

		expect(refused.status).toBe(401);
	});

	it('icons are public PNGs', async () => {
		const { port } = bootGateway();

		for (const size of [180, 192, 512]) {
			const response = await fetch(`http://localhost:${port}/icons/icon-${size}.png`);

			expect(response.status).toBe(200);
			expect(response.headers.get('content-type')).toBe('image/png');
			expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(100);
		}
	});

	it('the phone cookie opens /ws and /whoami until the phone is removed', async () => {
		const { port, phonesFile } = bootGateway();
		const headers = { origin: `http://localhost:${port}`, cookie: `${COOKIE_NAME}=${KEY}` };
		const socket = await openSocket(port, headers);

		socket.close();
		expect((await fetch(`http://localhost:${port}/whoami`, { headers })).status).toBe(200);

		writePhones(phonesFile, []);
		expect((await fetch(`http://localhost:${port}/whoami`, { headers })).status).toBe(401);
		await expect(openSocket(port, headers)).rejects.toThrow('rejected');
	});

	it('the tailscale origin is allowed once tailscale.json exists, without a restart', async () => {
		const { port, tailscaleFile } = bootGateway();
		const headers = { origin: 'https://mac.tail1.ts.net', cookie: `${COOKIE_NAME}=${TOKEN}` };

		await expect(openSocket(port, headers)).rejects.toThrow('rejected');

		writeFileSync(
			tailscaleFile,
			JSON.stringify({ host: 'mac.tail1.ts.net', url: 'https://mac.tail1.ts.net' }),
		);
		const socket = await openSocket(port, headers);

		socket.close();

		rmSync(tailscaleFile);
		await expect(openSocket(port, headers)).rejects.toThrow('rejected');
	});
});

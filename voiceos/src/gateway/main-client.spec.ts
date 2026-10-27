import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerMessage } from '../shared/protocol.js';
import { Store } from '../state/store.js';
import { configureLog } from '../log.js';
import { COOKIE_NAME, listAllowedOrigins } from './auth.js';
import { buildClientLogFields, MAX_CLIENT_LOG_FIELDS_BYTES } from './client-log.js';
import { describeDevice } from './phones.js';
import { startGateway, type Gateway } from './server.js';
import { createMainClient } from './main-client.js';
import { SpeakerSeat } from '../discord/seat.js';
import { parseClientMessage } from './validate.js';

const TOKEN = 'b'.repeat(64);
const logFile = join(mkdtempSync(join(tmpdir(), 'voiceos-client-log-')), 'voiceos.log');

configureLog({ quiet: true, file: logFile });

afterAll(() => configureLog({ quiet: true, file: null }));

let gateway: Gateway | null = null;
const received: unknown[] = [];

afterEach(() => {
	gateway?.stop();
	gateway = null;
	received.length = 0;
});

const bootGateway = (seat = new SpeakerSeat()) => {
	gateway = startGateway({
		onMainConnection: (client) => seat.claim(client),
		probeMs: 100,
		onDisconnect: (client) => seat.pageClosed(client),
		store: new Store(),
		token: TOKEN,
		port: 0,
		index: new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
		listAllowedOrigins: (port) => listAllowedOrigins({ port, proxyHost: null, proxyPort: null }),
		onMessage: (message) => received.push(message),
		onAudio: () => {},
		readHealth: () => ({}),
	});

	return gateway.port;
};

interface Client {
	socket: WebSocket;
	messages: ServerMessage[];
}

const MAC_CHROME =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const IPHONE =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const connect = (port: number, userAgent = MAC_CHROME): Promise<Client> =>
	new Promise((resolve, reject) => {
		const headers = {
			origin: `http://localhost:${port}`,
			cookie: `${COOKIE_NAME}=${TOKEN}`,
			'user-agent': userAgent,
		};
		const socket = new WebSocket(`ws://localhost:${port}/ws`, { headers } as unknown as string[]);
		const messages: ServerMessage[] = [];

		socket.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
		socket.onopen = () => resolve({ socket, messages });
		socket.onerror = () => reject(new Error('rejected'));
	});

const waitUntil = async (check: () => boolean) => {
	const deadline = Date.now() + 2000;

	while (!check()) {
		if (Date.now() > deadline) {
			throw new Error('timeout');
		}

		await Bun.sleep(5);
	}
};

const lastMain = (client: Client) =>
	client.messages.filter((message) => message.type === 'main_client').at(-1);

const helloTab = (client: Client, tabId: string) =>
	client.socket.send(JSON.stringify({ type: 'hello_tab', tabId }));

const claim = (client: Client) => client.socket.send(JSON.stringify({ type: 'claim_main' }));

describe('describeDevice', () => {
	it.each([
		[IPHONE, 'iPhone'],
		['Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/131.0 Mobile Safari/537.36', 'Android'],
		[MAC_CHROME, 'Mac · Chrome'],
		[
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
			'Mac · Safari',
		],
		[
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 Edg/131.0',
			'Windows · Edge',
		],
		['Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0', 'Linux · Firefox'],
		[null, 'Browser'],
	])('%s → %s', (agent, label) => expect(describeDevice(agent)).toBe(label));
});

describe('client_log', () => {
	it('caps cat and msg, refuses a bad level', () => {
		const parsed = parseClientMessage(
			JSON.stringify({
				type: 'client_log',
				level: 'info',
				cat: 'c'.repeat(80),
				msg: 'm'.repeat(900),
			}),
		);

		expect(parsed.ok && parsed.message.type === 'client_log' && parsed.message.cat.length).toBe(40);
		expect(parsed.ok && parsed.message.type === 'client_log' && parsed.message.msg.length).toBe(
			300,
		);
		expect(
			parseClientMessage(JSON.stringify({ type: 'client_log', level: 'loud', cat: 'a', msg: 'b' }))
				.ok,
		).toBe(false);
	});

	it('fields over 2 KB are dropped; reserved keys never override the line', () => {
		const message = {
			type: 'client_log' as const,
			level: 'info' as const,
			cat: 'mic',
			msg: 'ensure',
			fields: { big: 'x'.repeat(MAX_CLIENT_LOG_FIELDS_BYTES) },
		};

		expect(buildClientLogFields(message, { client: 'c1', phone: null })).toEqual({
			client: 'c1',
			phone: null,
			area: 'mic',
			fieldsDropped: MAX_CLIENT_LOG_FIELDS_BYTES + 10,
		});
		expect(
			buildClientLogFields(
				{ ...message, fields: { ok: true, cat: 'x', client: 'spoof' } },
				{ client: 'c1', phone: 'p1' },
			),
		).toEqual({ ok: true, client: 'c1', phone: 'p1', area: 'mic' });
	});

	it('is written to the log with the client, and never reaches the app', async () => {
		const port = bootGateway();
		const client = await connect(port);

		client.socket.send(
			JSON.stringify({
				type: 'client_log',
				level: 'warn',
				cat: 'mic',
				msg: 'getUserMedia failed',
				fields: { name: 'NotAllowedError' },
			}),
		);
		client.socket.send(JSON.stringify({ type: 'utterance', text: 'hi' }));
		await waitUntil(() => received.length === 1);

		const lines = readFileSync(logFile, 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		const line = lines.find((entry) => entry.msg === 'getUserMedia failed');

		expect(line).toMatchObject({
			level: 'warn',
			cat: 'client',
			area: 'mic',
			name: 'NotAllowedError',
			client: expect.stringMatching(/^c\d+$/),
			phone: null,
		});
		expect(received).toEqual([{ type: 'utterance', text: 'hi' }]);
		client.socket.close();
	});
});

describe('main screen', () => {
	it('on connect: the current main (none yet)', async () => {
		const port = bootGateway();
		const client = await connect(port);

		await waitUntil(() => lastMain(client) !== undefined);
		expect(lastMain(client)).toEqual({ type: 'main_client', tabId: null, device: '' });
		expect(client.messages.some((message) => (message.type as string) === 'you')).toBe(false);
		client.socket.close();
	});

	it('hello_tab takes only a short plain id; a claim without one is ignored', async () => {
		expect(parseClientMessage(JSON.stringify({ type: 'hello_tab', tabId: 'tab_A-1' })).ok).toBe(
			true,
		);
		expect(parseClientMessage(JSON.stringify({ type: 'hello_tab', tabId: 'a b' })).ok).toBe(false);
		expect(
			parseClientMessage(JSON.stringify({ type: 'hello_tab', tabId: 'x'.repeat(65) })).ok,
		).toBe(false);

		const seat = new SpeakerSeat();
		const port = bootGateway(seat);
		const client = await connect(port);

		claim(client);
		client.socket.send(JSON.stringify({ type: 'utterance', text: 'after' }));
		await waitUntil(() => received.length === 1);
		expect(seat.current).toBeNull();
		expect(lastMain(client)?.tabId).toBeNull();
		client.socket.close();
	});

	it('a claim is broadcast by tab with the device; a newcomer is told; a disconnect keeps it', async () => {
		const port = bootGateway();
		const mac = await connect(port);
		const phone = await connect(port, IPHONE);

		helloTab(mac, 'tab-mac');
		helloTab(phone, 'tab-phone');
		claim(phone);

		const phoneMain = { type: 'main_client' as const, tabId: 'tab-phone', device: 'iPhone' };

		await waitUntil(() => lastMain(mac)?.tabId === 'tab-phone');
		expect(lastMain(mac)).toEqual(phoneMain);
		expect(lastMain(phone)).toEqual(phoneMain);

		phone.socket.close();
		await Bun.sleep(30);

		const late = await connect(port);

		await waitUntil(() => lastMain(late) !== undefined);
		expect(lastMain(late)).toEqual(phoneMain);

		helloTab(mac, 'tab-mac');
		claim(mac);
		await waitUntil(() => lastMain(late)?.tabId === 'tab-mac');
		expect(lastMain(late)).toMatchObject({ device: 'Mac · Chrome' });
		expect(received).toEqual([]);
		mac.socket.close();
		late.socket.close();
	});

	it('the speaker seat follows the main tab: Use here, away, back on a new connection', async () => {
		const seat = new SpeakerSeat();
		const port = bootGateway(seat);
		const mac = await connect(port);
		const phone = await connect(port, IPHONE);
		const speak = () =>
			gateway?.send(seat.current ?? '', { type: 'open_url', url: 'https://x.test', title: 'line' });
		const heard = (client: Client) =>
			client.messages.filter((message) => message.type === 'open_url').length;

		helloTab(mac, 'tab-mac');
		helloTab(phone, 'tab-phone');
		claim(mac);
		await waitUntil(() => seat.current !== null);

		const macSeat = seat.current;

		// Use here on the phone.
		claim(phone);
		await waitUntil(() => seat.current !== macSeat);
		expect(speak()).toBe(true);
		await waitUntil(() => heard(phone) === 1);
		expect(heard(mac)).toBe(0);

		// The phone drops; the seat empties, the phone stays main.
		phone.socket.close();
		await waitUntil(() => seat.current === null);
		expect(lastMain(mac)?.tabId).toBe('tab-phone');

		// Back on a new connection: its hello_tab takes the seat again, no claim needed.
		const phoneAgain = await connect(port, IPHONE);

		helloTab(phoneAgain, 'tab-phone');
		await waitUntil(() => seat.current !== null);
		expect(speak()).toBe(true);
		await waitUntil(() => heard(phoneAgain) === 1);
		expect(heard(mac)).toBe(0);
		mac.socket.close();
		phoneAgain.socket.close();
	});

	it('a duplicated tab (same id, first page alive) is told tab_taken and never becomes main', async () => {
		const seat = new SpeakerSeat();
		const port = bootGateway(seat);
		const first = await connect(port);

		helloTab(first, 'tab-dup');
		claim(first);
		await waitUntil(() => lastMain(first)?.tabId === 'tab-dup');

		const firstSeat = seat.current;
		const copy = await connect(port);

		helloTab(copy, 'tab-dup');
		claim(copy);
		await waitUntil(() => copy.messages.some((message) => message.type === 'tab_taken'));
		await Bun.sleep(30);
		expect(seat.current).toBe(firstSeat);
		expect(first.socket.readyState).toBe(WebSocket.OPEN);

		// Its new id is accepted; it is not main until it claims.
		helloTab(copy, 'tab-copy');
		await Bun.sleep(30);
		expect(seat.current).toBe(firstSeat);
		expect(lastMain(copy)?.tabId).toBe('tab-dup');
		first.socket.close();
		copy.socket.close();
	});
});

describe('createMainClient (a dropped holder)', () => {
	const connection = (id: string) => ({ id, device: 'iPhone' });

	it('a holder that does not answer is a dropped socket: the same tab is back, and main again', async () => {
		const seats: string[] = [];
		const sent: Array<[string, unknown]> = [];
		const probed: string[] = [];
		const tracker = createMainClient({
			broadcast: () => {},
			send: (clientId, message) => sent.push([clientId, message]),
			probe: async (clientId) => {
				probed.push(clientId);

				return false;
			},
			onMainConnection: (clientId) => seats.push(clientId),
		});
		const dropped = connection('c1');
		const back = connection('c2');

		await tracker.handle({ type: 'hello_tab', tabId: 'tab-phone' }, dropped);
		await tracker.handle({ type: 'claim_main' }, dropped);
		await tracker.handle({ type: 'hello_tab', tabId: 'tab-phone' }, back);

		expect(probed).toEqual(['c1']);
		expect(sent).toEqual([]);
		expect(seats).toEqual(['c1', 'c2']);
		expect(tracker.message()).toEqual({
			type: 'main_client',
			tabId: 'tab-phone',
			device: 'iPhone',
		});
	});

	it('a claim sent while the hello is checked applies once it is accepted, not when refused', async () => {
		let answer: (isAlive: boolean) => void = () => {};
		const seats: string[] = [];
		const tracker = createMainClient({
			broadcast: () => {},
			send: () => {},
			probe: () => new Promise((resolve) => (answer = resolve)),
			onMainConnection: (clientId) => seats.push(clientId),
		});

		await tracker.handle({ type: 'hello_tab', tabId: 't' }, connection('c1'));

		const copy = connection('c2');
		const hello = tracker.handle({ type: 'hello_tab', tabId: 't' }, copy);

		await tracker.handle({ type: 'claim_main' }, copy);
		answer(true);
		await hello;
		expect(seats).toEqual([]);

		const reconnect = connection('c3');
		const second = tracker.handle({ type: 'hello_tab', tabId: 't' }, reconnect);

		await tracker.handle({ type: 'claim_main' }, reconnect);
		answer(false);
		await second;
		expect(seats).toEqual(['c3']);
	});

	it('a claim that arrives after tab_taken (the copy had not heard yet) is dropped, its new hello is not main', async () => {
		const seats: string[] = [];
		const sent: Array<[string, unknown]> = [];
		const tracker = createMainClient({
			broadcast: () => {},
			send: (clientId, message) => sent.push([clientId, message]),
			probe: async () => true,
			onMainConnection: (clientId) => seats.push(clientId),
		});
		const original = connection('c1');
		const copy = connection('c2');

		await tracker.handle({ type: 'hello_tab', tabId: 't' }, original);
		await tracker.handle({ type: 'claim_main' }, original);
		await tracker.handle({ type: 'hello_tab', tabId: 't' }, copy);
		await tracker.handle({ type: 'claim_main' }, copy);
		await tracker.handle({ type: 'hello_tab', tabId: 't-new' }, copy);

		expect(sent).toEqual([['c2', { type: 'tab_taken' }]]);
		expect(seats).toEqual(['c1']);
		expect(tracker.message()).toMatchObject({ tabId: 't' });

		// Use here afterwards is the developer's own: it counts.
		await tracker.handle({ type: 'claim_main' }, copy);
		expect(seats).toEqual(['c1', 'c2']);
	});
});

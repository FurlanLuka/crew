import { afterEach, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { connect as connectTcp, type Socket } from 'node:net';
import type { ServerMessage } from '../shared/protocol.js';
import { Store } from '../state/store.js';
import { configureLog } from '../log.js';
import { SpeakerSeat } from '../discord/seat.js';
import { COOKIE_NAME, listAllowedOrigins } from './auth.js';
import { startGateway, type Gateway } from './server.js';

configureLog({ quiet: true });

const TOKEN = 'c'.repeat(64);

let gateway: Gateway | null = null;

afterEach(() => {
	gateway?.stop();
	gateway = null;
});

const bootGateway = (seat: SpeakerSeat, probeMs: number) => {
	gateway = startGateway({
		store: new Store(),
		token: TOKEN,
		port: 0,
		probeMs,
		index: new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
		listAllowedOrigins: (port) => listAllowedOrigins({ port, proxyHost: null, proxyPort: null }),
		onMainConnection: (client) => seat.claim(client),
		onDisconnect: (client) => seat.pageClosed(client),
		onMessage: () => {},
		onAudio: () => {},
		readHealth: () => ({}),
	});

	return gateway.port;
};

const OPCODE_TEXT = 0x1;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

// Client frames are masked (RFC 6455 §5.3).
const encodeFrame = (opcode: number, payload: Buffer): Buffer => {
	const mask = randomBytes(4);
	const length = payload.length;
	const header =
		length < 126
			? Buffer.from([0x80 | opcode, 0x80 | length])
			: Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 0xff]);
	const masked = Buffer.from(payload.map((byte, index) => byte ^ (mask[index % 4] ?? 0)));

	return Buffer.concat([header, mask, masked]);
};

interface RawClient {
	socket: Socket;
	pings: number;
	messages: ServerMessage[];
	isClosed: boolean;
	sendJson: (value: unknown) => void;
}

// A WebSocket by hand: every client in Bun answers pings itself, and a dropped iOS socket is one
// that never does. answerPings false is that phone.
const connectRaw = (port: number, answerPings: boolean): Promise<RawClient> =>
	new Promise((resolve, reject) => {
		const socket = connectTcp(port, '127.0.0.1');
		let buffer = Buffer.alloc(0);
		let isUpgraded = false;
		const client: RawClient = {
			socket,
			pings: 0,
			messages: [],
			isClosed: false,
			sendJson: (value) =>
				socket.write(encodeFrame(OPCODE_TEXT, Buffer.from(JSON.stringify(value)))),
		};

		const readFrames = () => {
			while (buffer.length >= 2) {
				const opcode = (buffer[0] ?? 0) & 0x0f;
				let length = (buffer[1] ?? 0) & 0x7f;
				let offset = 2;

				if (length === 126) {
					length = buffer.readUInt16BE(2);
					offset = 4;
				} else if (length === 127) {
					length = Number(buffer.readBigUInt64BE(2));
					offset = 10;
				}

				if (buffer.length < offset + length) {
					return;
				}

				const payload = buffer.subarray(offset, offset + length);

				buffer = buffer.subarray(offset + length);

				if (opcode === OPCODE_PING) {
					client.pings += 1;

					if (answerPings) {
						socket.write(encodeFrame(OPCODE_PONG, Buffer.from(payload)));
					}
				} else if (opcode === OPCODE_TEXT) {
					client.messages.push(JSON.parse(payload.toString()));
				}
			}
		};

		socket.on('data', (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);

			if (!isUpgraded) {
				const end = buffer.indexOf('\r\n\r\n');

				if (end < 0) {
					return;
				}

				if (!buffer.subarray(0, end).toString().startsWith('HTTP/1.1 101')) {
					reject(new Error('refused'));

					return;
				}

				isUpgraded = true;
				buffer = buffer.subarray(end + 4);
				resolve(client);
			}

			readFrames();
		});
		socket.on('close', () => {
			client.isClosed = true;
		});
		socket.on('error', reject);
		socket.write(
			[
				'GET /ws HTTP/1.1',
				`Host: localhost:${port}`,
				'Upgrade: websocket',
				'Connection: Upgrade',
				`Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
				'Sec-WebSocket-Version: 13',
				`Origin: http://localhost:${port}`,
				`Cookie: ${COOKIE_NAME}=${TOKEN}`,
				'',
				'',
			].join('\r\n'),
		);
	});

const waitUntil = async (check: () => boolean, timeoutMs = 3000) => {
	const deadline = Date.now() + timeoutMs;

	while (!check()) {
		if (Date.now() > deadline) {
			throw new Error('timeout');
		}

		await Bun.sleep(5);
	}
};

const tabTaken = (client: RawClient) =>
	client.messages.some((message) => message.type === 'tab_taken');

describe('two pages saying one tab id', () => {
	it('a holder that never answers the ping is terminated; the newcomer keeps the id and the seat', async () => {
		const seat = new SpeakerSeat();
		const port = bootGateway(seat, 100);
		const dropped = await connectRaw(port, false);

		dropped.sendJson({ type: 'hello_tab', tabId: 'tab-phone' });
		dropped.sendJson({ type: 'claim_main' });
		await waitUntil(() => seat.current !== null);

		const droppedSeat = seat.current;
		const back = await connectRaw(port, true);

		back.sendJson({ type: 'hello_tab', tabId: 'tab-phone' });
		await waitUntil(() => dropped.isClosed);
		await waitUntil(() => seat.current !== null && seat.current !== droppedSeat);
		expect(dropped.pings).toBe(1);
		expect(tabTaken(back)).toBe(false);
		expect(back.isClosed).toBe(false);
		back.socket.destroy();
	});

	it('two hellos at once against a live holder: one ping, both told tab_taken, the holder kept', async () => {
		const seat = new SpeakerSeat();
		const port = bootGateway(seat, 500);
		const holder = await connectRaw(port, true);

		holder.sendJson({ type: 'hello_tab', tabId: 'tab-dup' });
		holder.sendJson({ type: 'claim_main' });
		await waitUntil(() => seat.current !== null);

		const holderSeat = seat.current;
		const [first, second] = await Promise.all([connectRaw(port, true), connectRaw(port, true)]);

		first.sendJson({ type: 'hello_tab', tabId: 'tab-dup' });
		second.sendJson({ type: 'hello_tab', tabId: 'tab-dup' });
		await waitUntil(() => tabTaken(first) && tabTaken(second));
		// Past the probe's timeout: a second timer left running would have closed the holder by now.
		await Bun.sleep(700);
		expect(holder.pings).toBe(1);
		expect(holder.isClosed).toBe(false);
		expect(seat.current).toBe(holderSeat);

		for (const client of [holder, first, second]) {
			client.socket.destroy();
		}
	});
});

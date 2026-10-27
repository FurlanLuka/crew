import type { Server, ServerWebSocket } from 'bun';
import type { AppClientMessage, ServerMessage } from '../shared/protocol.js';
import type { Store } from '../state/store.js';
import { createLogger } from '../log.js';
import {
	authorizeRequest,
	createSessionCookie,
	areTokensEqual,
	checkRequest,
	isSecureRequest,
	type Authorization,
} from './auth.js';
import { createMainClient } from './main-client.js';
import {
	describeDevice,
	deviceFromUserAgent,
	type FindPhone,
	type Phone,
	type RecordPhoneSeen,
} from './phones.js';
import { createPhoneRoutes } from './phone-page.js';
import { handleCrewRequest, type RunSetupCommand } from '../crew/api.js';
import { handleAttachRequest, type AttachFile } from './attach.js';
import { parseClientMessage } from './validate.js';
import type { MediaFile } from '../sessions/media.js';

const log = createLogger('gateway');
const TOPIC = 'events';

export interface ClientData {
	id: string;
	// Set when the page signed in with a phone key, so removing that phone can close the socket.
	phoneId?: string;
	// The "open on <device>" label, read from the handshake's User-Agent.
	device: string;
	// The page's own id from hello_tab: which tab this connection is, across reconnects.
	tabId?: string;
	hasPendingClaim?: boolean;
	isTabRefused?: boolean;
}

// A close code the page reads as "signed out", not a network drop to reconnect from.
export const REVOKED_CLOSE_CODE = 4401;
const PHONE_SWEEP_MS = 2000;
// How long a connection has to answer a ping before it counts as dropped.
const PROBE_MS = 2000;

export interface GatewayOptions {
	store: Store;
	token: string;
	port: number;
	listAllowedOrigins: (port: number) => string[];
	index: Bun.HTMLBundle | Response;
	onMessage: (message: AppClientMessage, clientId: string) => void;
	onAudio: (chunk: Uint8Array, clientId: string) => void;
	// After the snapshot is sent: a page (re)connected, so anything said now has a tab to play in.
	onConnect?: (clientId: string) => void;
	onDisconnect?: (clientId: string) => void;
	// The main tab's live connection changed (a claim, or that tab back on a new connection):
	// speech moves to it.
	onMainConnection?: (clientId: string) => void;
	readHealth: () => Record<string, unknown>;
	// A stored image by its name in Voice OS's media folder — nothing else on disk is ever served.
	readMedia?: (name: string) => MediaFile;
	// Set up's commands (POST /api/crew); tests pass a fake. Without it the route answers 503.
	runCrew?: RunSetupCommand;
	// A file attached on a session's page (POST /api/attach). Without it the route answers 503.
	attachFile?: AttachFile;
	// Phones signed in with their own key (phones.json, read per request). Without it only the token works.
	findPhone?: FindPhone;
	hasPhone?: (id: string) => boolean;
	recordPhoneSeen?: RecordPhoneSeen;
	// How often open phone sockets are checked against phones.json; tests shorten it.
	phoneSweepMs?: number;
	// How long a ping waits for its pong when two pages say the same tab id; tests shorten it.
	probeMs?: number;
	development?: boolean;
}

export interface Gateway {
	port: number;
	broadcast: (message: ServerMessage) => void;
	send: (client: string, message: ServerMessage) => boolean;
	countClients: () => number;
	stop: () => void;
}

// Counts connections for the life of the process, so client ids never repeat.
let clientCounter = 0;

const createTextResponse = (
	status: number,
	body: string,
	headers: Record<string, string> = {},
): Response => {
	return new Response(body, {
		status,
		headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
	});
};

export const startGateway = (options: GatewayOptions): Gateway => {
	const { store, token } = options;
	const serverId = `${process.pid}-${Date.now()}`;
	// Known only once the server has its port. Origins are listed per check: tailscale.json can
	// appear while the server runs, and the page must load from it without a restart.
	let listenPort = options.port;
	const readOrigins = () => options.listAllowedOrigins(listenPort);
	const clients = new Map<string, ServerWebSocket<ClientData>>();
	// Pings out to a connection whose tab id another page said: resolved by its pong or the timeout.
	const probes = new Map<string, (isAlive: boolean) => void>();
	// One ping per connection at a time: a second one would leave the first timer to terminate a
	// connection whose pong only reached the second.
	const pendingProbes = new Map<string, Promise<boolean>>();

	const probe = (clientId: string): Promise<boolean> => {
		const socket = clients.get(clientId);

		if (!socket) {
			return Promise.resolve(false);
		}

		const pending = pendingProbes.get(clientId);

		if (pending) {
			return pending;
		}

		const answer = new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				probes.delete(clientId);
				pendingProbes.delete(clientId);
				log.info('connection silent, closed', { client: clientId });
				// Dropped without a close (iOS): nothing would ever end it otherwise.
				socket.terminate();
				resolve(false);
			}, options.probeMs ?? PROBE_MS);

			probes.set(clientId, (isAlive) => {
				clearTimeout(timer);
				probes.delete(clientId);
				pendingProbes.delete(clientId);
				resolve(isAlive);
			});
			socket.ping();
		});

		pendingProbes.set(clientId, answer);

		return answer;
	};

	const mainClient = createMainClient({
		broadcast: (message) => server.publish(TOPIC, JSON.stringify(message)),
		send: (clientId, message) => clients.get(clientId)?.send(JSON.stringify(message)),
		probe,
		onMainConnection: options.onMainConnection,
	});

	const authorize = (request: Request): Authorization<Phone> => {
		const authorization = authorizeRequest(request, token, options.findPhone);

		if (authorization && authorization !== 'token') {
			options.recordPhoneSeen?.(
				authorization.id,
				deviceFromUserAgent(request.headers.get('user-agent')),
			);
		}

		return authorization;
	};

	const phoneRoutes = createPhoneRoutes({
		// The app's page is Bun's bundle; asking our own / is the one way to get its built HTML.
		fetchAppHtml: () => fetch(`http://127.0.0.1:${listenPort}/`),
		cacheAppHtml: !options.development,
		findPhone: options.findPhone,
		recordPhoneSeen: options.recordPhoneSeen,
	});

	const server: Server<ClientData> = Bun.serve<ClientData>({
		hostname: '127.0.0.1',
		port: options.port,
		development: options.development ?? false,
		routes: {
			// One page, three halves: the browser's router picks Home, Voice OS or Set up from the path,
			// so a deep link or a refresh lands where it was.
			'/': options.index,
			'/voice': options.index,
			'/voice/*': options.index,
			'/setup': options.index,
			'/setup/*': options.index,
			'/api/crew': (request: Request) => {
				const { runCrew } = options;

				if (!runCrew) {
					return createTextResponse(503, 'crew is not available here');
				}

				const authorization = authorize(request);

				return handleCrewRequest({
					request,
					origins: readOrigins(),
					isAuthorized: Boolean(authorization),
					isPhone: Boolean(authorization && authorization !== 'token'),
					runCrew,
				});
			},
			'/api/attach': (request: Request) => {
				const { attachFile } = options;

				if (!attachFile) {
					return createTextResponse(503, 'attachments are not available here');
				}

				return handleAttachRequest({
					request,
					origins: readOrigins(),
					isAuthorized: Boolean(authorize(request)),
					attachFile,
				});
			},
			'/healthz': () => Response.json({ ok: true, ...options.readHealth() }),
			...phoneRoutes,
			'/whoami': (request: Request) =>
				authorize(request) ? Response.json({ ok: true }) : createTextResponse(401, 'unauthorized'),
			'/media': (request: Request) => {
				if (!authorize(request)) {
					log.warn('media unauthorized');

					return createTextResponse(401, 'unauthorized');
				}

				const name = new URL(request.url).searchParams.get('name') ?? '';
				const file = options.readMedia?.(name) ?? { ok: false, reason: 'missing' };

				if (!file.ok) {
					log.warn('media refused', { name, reason: file.reason });

					return createTextResponse(404, 'not found');
				}

				log.debug('media served', { name });

				// Named by content: the same name is always the same picture.
				return new Response(Bun.file(file.path), {
					headers: {
						'content-type': file.contentType,
						'cache-control': 'private, max-age=31536000, immutable',
						'x-content-type-options': 'nosniff',
					},
				});
			},
			'/login': (request: Request) => {
				const provided = new URL(request.url).searchParams.get('token');

				if (!areTokensEqual(provided, token)) {
					log.warn('login refused');

					return createTextResponse(
						401,
						'This link is not valid. Run `crew` to print a fresh one.',
					);
				}

				// Redirect so the token leaves the address bar and browser history.
				return new Response(null, {
					status: 302,
					headers: {
						location: '/',
						'set-cookie': createSessionCookie(token, isSecureRequest(request)),
					},
				});
			},
			'/ws': (request: Request, bunServer: Server<ClientData>) => {
				const origin = request.headers.get('origin');
				const authorization = authorize(request);
				const refusal = checkRequest({
					origin,
					origins: readOrigins(),
					isAuthorized: Boolean(authorization),
				});

				if (refusal) {
					log.warn('ws refused', { status: refusal.status, origin });

					return createTextResponse(refusal.status, refusal.text);
				}

				const id = `c${++clientCounter}`;
				const device = describeDevice(request.headers.get('user-agent'));
				const data: ClientData =
					authorization && authorization !== 'token'
						? { id, device, phoneId: authorization.id }
						: { id, device };

				if (bunServer.upgrade(request, { data })) {
					return undefined;
				}

				return createTextResponse(400, 'expected a WebSocket upgrade');
			},
		},
		fetch: () => createTextResponse(404, 'not found'),
		websocket: {
			open(socket: ServerWebSocket<ClientData>) {
				// Snapshot and subscribe in the same tick so no input slips between; the client replays from seq + 1.
				socket.send(
					JSON.stringify({
						type: 'snapshot',
						state: store.state,
						serverId,
					} satisfies ServerMessage),
				);
				socket.subscribe(TOPIC);
				clients.set(socket.data.id, socket);
				socket.send(JSON.stringify(mainClient.message()));
				log.info('client connected', {
					client: socket.data.id,
					seq: store.state.seq,
					phone: socket.data.phoneId ?? null,
				});
				options.onConnect?.(socket.data.id);
			},
			message(socket, raw) {
				if (typeof raw !== 'string') {
					options.onAudio(raw instanceof Uint8Array ? raw : new Uint8Array(raw), socket.data.id);

					return;
				}

				const parsed = parseClientMessage(raw);

				if (!parsed.ok) {
					log.warn('bad client message', { client: socket.data.id, error: parsed.error });
					socket.send(
						JSON.stringify({ type: 'error', message: parsed.error } satisfies ServerMessage),
					);

					return;
				}

				const { message } = parsed;

				if (
					message.type === 'client_log' ||
					message.type === 'hello_tab' ||
					message.type === 'claim_main'
				) {
					void mainClient.handle(message, socket.data);

					return;
				}

				options.onMessage(message, socket.data.id);
			},
			pong(socket) {
				probes.get(socket.data.id)?.(true);
			},
			close(socket) {
				clients.delete(socket.data.id);
				log.info('client disconnected', { client: socket.data.id });
				probes.get(socket.data.id)?.(false);
				mainClient.disconnected(socket.data);
				options.onDisconnect?.(socket.data.id);
			},
		},
	});

	const port = server.port ?? options.port;

	listenPort = port;

	const unsubscribe = store.subscribe((stamped) => {
		server.publish(TOPIC, JSON.stringify({ type: 'input', stamped } satisfies ServerMessage));
	});

	// A request is checked when it arrives, but a socket stays open: removing a phone must also end
	// the connections it already has. phones.json is cached by mtime, so a sweep costs one stat.
	const { hasPhone } = options;
	const sweep = hasPhone
		? setInterval(() => {
				for (const socket of clients.values()) {
					const { phoneId } = socket.data;

					if (phoneId && !hasPhone(phoneId)) {
						log.info('phone removed, closing its socket', {
							client: socket.data.id,
							phone: phoneId,
						});
						socket.close(REVOKED_CLOSE_CODE, 'phone removed');
					}
				}
			}, options.phoneSweepMs ?? PHONE_SWEEP_MS)
		: null;

	sweep?.unref();

	log.info('listening', { port, origins: readOrigins() });

	return {
		port,
		broadcast: (message) => server.publish(TOPIC, JSON.stringify(message)),
		send: (client, message) => {
			const socket = clients.get(client);

			if (!socket) {
				return false;
			}

			socket.send(JSON.stringify(message));

			return true;
		},
		countClients: () => clients.size,
		stop: () => {
			if (sweep) {
				clearInterval(sweep);
			}

			unsubscribe();
			server.stop(true);
		},
	};
};

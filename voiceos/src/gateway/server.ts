import type { Server, ServerWebSocket } from 'bun';
import type { ClientMessage, ServerMessage } from '../shared/protocol.js';
import type { Store } from '../state/store.js';
import { createLogger } from '../log.js';
import { isAuthorized, createSessionCookie, areTokensEqual, checkRequest } from './auth.js';
import { handleCrewRequest, type RunSetupCommand } from '../crew/api.js';
import { handleAttachRequest, type AttachFile } from './attach.js';
import { parseClientMessage } from './validate.js';
import type { MediaFile } from '../sessions/media.js';

const log = createLogger('gateway');
const TOPIC = 'events';

export interface ClientData {
	id: string;
}

export interface GatewayOptions {
	store: Store;
	token: string;
	port: number;
	listAllowedOrigins: (port: number) => string[];
	index: Bun.HTMLBundle | Response;
	onMessage: (message: ClientMessage, clientId: string) => void;
	onAudio: (chunk: Uint8Array, clientId: string) => void;
	// After the snapshot is sent: a page (re)connected, so anything said now has a tab to play in.
	onConnect?: (clientId: string) => void;
	onDisconnect?: (clientId: string) => void;
	readHealth: () => Record<string, unknown>;
	// A stored image by its name in Voice OS's media folder — nothing else on disk is ever served.
	readMedia?: (name: string) => MediaFile;
	// Set up's commands (POST /api/crew); tests pass a fake. Without it the route answers 503.
	runCrew?: RunSetupCommand;
	// A file attached on a session's page (POST /api/attach). Without it the route answers 503.
	attachFile?: AttachFile;
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
	// Known only once the server has its port; the /ws route reads it on each handshake.
	let origins: string[] = [];
	const clients = new Map<string, ServerWebSocket<ClientData>>();

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

				return handleCrewRequest({
					request,
					origins,
					isAuthorized: isAuthorized(request, token),
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
					origins,
					isAuthorized: isAuthorized(request, token),
					attachFile,
				});
			},
			'/healthz': () => Response.json({ ok: true, ...options.readHealth() }),
			'/whoami': (request: Request) =>
				isAuthorized(request, token)
					? Response.json({ ok: true })
					: createTextResponse(401, 'unauthorized'),
			'/media': (request: Request) => {
				if (!isAuthorized(request, token)) {
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
					headers: { location: '/', 'set-cookie': createSessionCookie(token) },
				});
			},
			'/ws': (request: Request, bunServer: Server<ClientData>) => {
				const origin = request.headers.get('origin');
				const refusal = checkRequest({
					origin,
					origins,
					isAuthorized: isAuthorized(request, token),
				});

				if (refusal) {
					log.warn('ws refused', { status: refusal.status, origin });

					return createTextResponse(refusal.status, refusal.text);
				}

				const id = `c${++clientCounter}`;

				if (bunServer.upgrade(request, { data: { id } })) {
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
				log.info('client connected', { client: socket.data.id, seq: store.state.seq });
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

				options.onMessage(parsed.message, socket.data.id);
			},
			close(socket) {
				clients.delete(socket.data.id);
				log.info('client disconnected', { client: socket.data.id });
				options.onDisconnect?.(socket.data.id);
			},
		},
	});

	const port = server.port ?? options.port;

	origins = options.listAllowedOrigins(port);

	const unsubscribe = store.subscribe((stamped) => {
		server.publish(TOPIC, JSON.stringify({ type: 'input', stamped } satisfies ServerMessage));
	});

	log.info('listening', { port, origins });

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
			unsubscribe();
			server.stop(true);
		},
	};
};

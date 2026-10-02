// `query.sock` on a remote: crew server logs (debug-notes, notes) run here asks the main through this
// daemon's link. One line `{"args":[…]}` in, one answer line out, then the connection ends. crew's
// client (crew/internal/voice/remote_query.go) reads the same shapes: both sides test against
// test/fixtures/shared/query-socket.json.

import { chmodSync, rmSync } from 'node:fs';
import { z } from 'zod';
import { createLogger } from '../log.js';
import { createLineDecoder, crewArgsSchema, type CrewCallResult } from './protocol.js';
import { createSocketWriter, type SocketWriter } from './socket-writer.js';

const log = createLogger('remote');

export type QueryFailureReason = 'no-main' | 'timeout' | 'error';

export type QueryAnswer =
	| { ok: true; value: CrewCallResult }
	| { ok: false; reason: QueryFailureReason; error: string };

export type AskMain = (args: string[]) => Promise<QueryAnswer>;

const requestSchema = z.object({ args: crewArgsSchema });

export const parseQueryRequest = (line: string): string[] | null => {
	try {
		const parsed = requestSchema.safeParse(JSON.parse(line));

		return parsed.success ? parsed.data.args : null;
	} catch {
		return null;
	}
};

interface QuerySocketData {
	writer: SocketWriter;
	decode: (chunk: Uint8Array) => void;
	isAsked: boolean;
	// Ends the connection once the answer has left: an answer of megabytes waits on drains.
	isAnswered: boolean;
}

export interface ListenQuerySocketParams {
	path: string;
	askMain: AskMain;
}

export const listenQuerySocket = ({ path, askMain }: ListenQuerySocketParams) => {
	const encoder = new TextEncoder();

	const endWhenSent = (socket: { end: () => void; data: QuerySocketData }): void => {
		if (socket.data.isAnswered && socket.data.writer.waiting === 0) {
			socket.end();
		}
	};

	// A socket left by a daemon that died would refuse the new one.
	rmSync(path, { force: true });

	const server = Bun.listen<QuerySocketData>({
		unix: path,
		socket: {
			open(socket) {
				const answer = (reply: QueryAnswer): void => {
					socket.data.writer.write(encoder.encode(`${JSON.stringify(reply)}\n`));
					socket.data.isAnswered = true;
					endWhenSent(socket);
				};

				socket.data = {
					writer: createSocketWriter(socket),
					isAsked: false,
					isAnswered: false,
					decode: createLineDecoder((line) => {
						// One question per connection: anything after the first line is ignored.
						if (socket.data.isAsked) {
							return;
						}

						socket.data.isAsked = true;

						const args = parseQueryRequest(line);

						if (!args) {
							log.warn('query refused: not a request', { chars: line.length });
							answer({ ok: false, reason: 'error', error: 'not a query request' });

							return;
						}

						const startedAt = Date.now();

						void askMain(args)
							.catch(
								(error: unknown): QueryAnswer => ({
									ok: false,
									reason: 'error',
									error: String(error),
								}),
							)
							.then((reply) => {
								log.info('query answered', {
									command: args.slice(0, 2).join(' '),
									ok: reply.ok,
									...(reply.ok ? { code: reply.value.code } : { reason: reply.reason }),
									ms: Date.now() - startedAt,
								});
								answer(reply);
							});
					}),
				};
			},
			data(socket, chunk) {
				socket.data.decode(chunk);
			},
			drain(socket) {
				socket.data.writer.drain();
				endWhenSent(socket);
			},
			error(_socket, error) {
				log.warn('query socket error', { error: String(error) });
			},
		},
	});

	// Only this user may ask: the answers carry what the developer said.
	chmodSync(path, 0o600);

	return {
		stop: (): void => {
			server.stop(true);
			rmSync(path, { force: true });
		},
	};
};

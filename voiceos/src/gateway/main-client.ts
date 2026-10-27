import { createLogger } from '../log.js';
import type { GatewayClientMessage, ServerMessage } from '../shared/protocol.js';
import { writeClientLog } from './client-log.js';

const log = createLogger('gateway');

export interface ConnectionInfo {
	id: string;
	phoneId?: string;
	device: string;
	// Set once hello_tab is accepted: the page's own id, the same across its reconnects.
	tabId?: string;
	// A claim that came while this connection's hello_tab was still being checked.
	hasPendingClaim?: boolean;
	// Told tab_taken and not yet said its new id: a claim now is the copy's own load claiming, sent
	// before it heard, and is dropped.
	isTabRefused?: boolean;
}

export interface MainClientParams {
	broadcast: (message: ServerMessage) => void;
	send: (clientId: string, message: ServerMessage) => void;
	// Whether a connection still answers (a ping, a short wait). One that does not is closed by the
	// probe: iOS leaves a dropped socket looking open, and its tab is back on a new one.
	probe: (clientId: string) => Promise<boolean>;
	// The main tab's live connection is where speech plays: app.ts moves the speaker seat to it.
	onMainConnection?: (clientId: string) => void;
}

export interface MainClientTracker {
	message: () => ServerMessage;
	handle: (message: GatewayClientMessage, connection: ConnectionInfo) => Promise<void>;
	disconnected: (connection: ConnectionInfo) => void;
}

// Keyed by tab, not connection: iOS drops a socket without closing it, and the page comes back on a
// new connection. Kept until another tab claims, so a reconnect finds itself still main. Never
// persisted: it only says who is connected now.
export const createMainClient = ({
	broadcast,
	send,
	probe,
	onMainConnection,
}: MainClientParams): MainClientTracker => {
	let main: { tabId: string; device: string } | null = null;
	// The connection speech goes to: the main tab's latest, none while it is away.
	let liveConnection: string | null = null;
	// Connections whose hello_tab was accepted, by id.
	const tabs = new Map<string, ConnectionInfo>();

	const message = (): ServerMessage => ({
		type: 'main_client',
		tabId: main?.tabId ?? null,
		device: main?.device ?? '',
	});

	const seat = (connection: ConnectionInfo) => {
		liveConnection = connection.id;
		onMainConnection?.(connection.id);
	};

	const claim = (connection: ConnectionInfo, tabId: string) => {
		main = { tabId, device: connection.device };
		log.info('main screen claimed', {
			client: connection.id,
			tab: tabId,
			phone: connection.phoneId ?? null,
			device: connection.device,
		});
		seat(connection);
		broadcast(message());
	};

	// "Duplicate tab" copies sessionStorage, so two pages can say the same tab id. A holder that
	// still answers is another page: the newcomer is told to make its own id.
	const isHeldElsewhere = async (tabId: string, connection: ConnectionInfo): Promise<boolean> => {
		const holder = [...tabs.values()].find(
			(other) => other.tabId === tabId && other.id !== connection.id,
		);

		if (!holder) {
			return false;
		}

		const isAlive = await probe(holder.id);

		// Asked meanwhile: the holder may have closed while the ping was out.
		return isAlive && tabs.get(holder.id)?.tabId === tabId;
	};

	const hello = async (tabId: string, connection: ConnectionInfo) => {
		const phone = connection.phoneId ?? null;

		if (await isHeldElsewhere(tabId, connection)) {
			log.info('tab id taken by a live page', { client: connection.id, tab: tabId, phone });
			connection.hasPendingClaim = false;
			connection.isTabRefused = true;
			send(connection.id, { type: 'tab_taken' });

			return;
		}

		connection.tabId = tabId;
		tabs.set(connection.id, connection);

		if (connection.hasPendingClaim) {
			connection.hasPendingClaim = false;
			claim(connection, tabId);

			return;
		}

		if (main?.tabId === tabId) {
			log.info('main tab back', { client: connection.id, tab: tabId, phone });
			seat(connection);
		}
	};

	return {
		message,
		handle: async (incoming, connection) => {
			switch (incoming.type) {
				case 'client_log':
					writeClientLog(incoming, { client: connection.id, phone: connection.phoneId ?? null });

					return;
				case 'hello_tab':
					// Not this tab's until checked: a claim sent meanwhile waits for the answer.
					connection.tabId = undefined;
					connection.hasPendingClaim = false;
					connection.isTabRefused = false;
					tabs.delete(connection.id);
					await hello(incoming.tabId, connection);

					return;
				case 'claim_main':
					if (connection.tabId) {
						claim(connection, connection.tabId);

						return;
					}

					if (connection.isTabRefused) {
						log.info('main claim from a duplicated tab, dropped', { client: connection.id });

						return;
					}

					// A hello_tab may still be under check; it applies the claim when accepted.
					connection.hasPendingClaim = true;
					log.debug('main claim waits for its tab id', { client: connection.id });
			}
		},
		disconnected: (connection) => {
			tabs.delete(connection.id);

			// The tab stays main: its next connection's hello_tab takes the seat back.
			if (liveConnection === connection.id) {
				liveConnection = null;
				log.info('main tab away', { client: connection.id, tab: connection.tabId ?? null });
			}
		},
	};
};

import { createLogger } from '../log.js';
import type { ServerMessage } from '../shared/protocol.js';
import type { HandsFreeResult } from '../tools/hands-free.js';

const log = createLogger('hands-free');

export interface HandsFreeSwitchOptions {
	isListening: (client: string) => boolean;
	unlisten: (client: string) => void;
	// False when that tab is gone.
	send: (client: string, message: ServerMessage) => boolean;
	say: (text: string) => void;
}

export const createHandsFreeSwitch =
	({ isListening, unlisten, send, say }: HandsFreeSwitchOptions) =>
	(client: string) =>
	(isOn: boolean): HandsFreeResult => {
		// Voice OS says it itself, so the developer hears the switch even when the kernel stays silent.
		const isAlready = isListening(client) === isOn;

		log.info('switch by voice', { client, isOn, isAlready });

		if (isAlready) {
			say(`Hands-free is already ${isOn ? 'on' : 'off'}.`);

			return 'already';
		}

		const isSent = send(
			client,
			isOn ? { type: 'listen_on' } : { type: 'listen_off', reason: 'turned off by voice' },
		);

		if (!isSent) {
			log.warn('no tab to switch', { client });

			return 'no_tab';
		}

		// The tab stops its mic on listen_off; the server stops hearing it now, not a round trip later.
		if (!isOn) {
			unlisten(client);
		}

		say(`Hands-free ${isOn ? 'on' : 'off'}.`);

		return 'changed';
	};

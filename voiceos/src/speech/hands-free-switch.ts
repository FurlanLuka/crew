import { createLogger } from '../log.js';
import type { ListenMode, ServerMessage } from '../shared/protocol.js';
import type { HandsFreeResult } from '../tools/hands-free.js';

const log = createLogger('hands-free');

export interface ListenSwitchOptions {
	modeOf: (client: string) => ListenMode;
	unlisten: (client: string) => void;
	// False when that tab is gone.
	send: (client: string, message: ServerMessage) => boolean;
	say: (text: string) => void;
}

// Never says "Voice OS": heard back through the open mic, it would call a turn.
const MODE_LINES: Record<ListenMode, string> = {
	push: 'Push to talk.',
	'on-demand': 'On demand. Say my name first.',
	'hands-free': 'Hands-free.',
};

const ALREADY_LINES: Record<ListenMode, string> = {
	push: 'Already push to talk.',
	'on-demand': 'Already on demand.',
	'hands-free': 'Already hands-free.',
};

export const createListenSwitch =
	({ modeOf, unlisten, send, say }: ListenSwitchOptions) =>
	(client: string) =>
	(mode: ListenMode): HandsFreeResult => {
		// Voice OS says it itself, so the developer hears the switch even when the kernel stays silent.
		const isAlready = modeOf(client) === mode;

		log.info('switch by voice', { client, mode, isAlready });

		if (isAlready) {
			say(ALREADY_LINES[mode]);

			return 'already';
		}

		const isSent = send(
			client,
			mode === 'push'
				? { type: 'listen_off', reason: 'turned off by voice' }
				: { type: 'listen_on', mode },
		);

		if (!isSent) {
			log.warn('no tab to switch', { client });

			return 'no_tab';
		}

		// The tab stops its mic on listen_off; the server stops hearing it now, not a round trip later.
		if (mode === 'push') {
			unlisten(client);
		}

		say(MODE_LINES[mode]);

		return 'changed';
	};

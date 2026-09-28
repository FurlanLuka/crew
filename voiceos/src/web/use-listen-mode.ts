import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, ListenMode } from '../shared/protocol.js';
import type { Mic } from './audio.js';
import { listenModeStorageKey, listenStartMessage, readStoredListenMode } from './listen-mode.js';
import type { ListenCommand, MicStatus } from './types.js';

const readListenMode = (): ListenMode => {
	try {
		return readStoredListenMode(sessionStorage);
	} catch {
		return 'push';
	}
};

const writeListenMode = (mode: ListenMode): void => {
	try {
		sessionStorage.setItem(listenModeStorageKey, mode);
	} catch {
		// Private mode or blocked storage: the mode just is not remembered.
	}
};

export interface UseListenModeParams {
	isConnected: boolean;
	listenCommand: ListenCommand | null;
	getMic: () => Mic;
	send: (message: ClientMessage) => void;
	onMicStatusChange: (mic: MicStatus) => void;
}

export const useListenMode = ({
	isConnected,
	listenCommand,
	getMic,
	send,
	onMicStatusChange,
}: UseListenModeParams) => {
	const [listenMode, setListenMode] = useState(readListenMode);
	// The ref lets handlers see the latest value without being recreated.
	const listenModeRef = useRef(listenMode);
	listenModeRef.current = listenMode;

	useEffect(() => writeListenMode(listenMode), [listenMode]);

	useEffect(() => {
		if (listenCommand) {
			setListenMode(listenCommand.mode);
		}
	}, [listenCommand]);

	// Announced on every (re)connect: a new socket, or a restarted server, knows nothing of it.
	useEffect(() => {
		if (listenMode === 'push' || !isConnected) {
			return;
		}

		const microphone = getMic();
		const lifetime = new AbortController();
		microphone
			.ensure('handsFree')
			.then((sampleRate) => {
				if (lifetime.signal.aborted) {
					return;
				}

				microphone.listen(() => send(listenStartMessage(listenMode, sampleRate)));
				onMicStatusChange('live');
			})
			.catch(() => {
				if (lifetime.signal.aborted) {
					return;
				}

				setListenMode('push');
				onMicStatusChange('denied');
			});

		return () => {
			lifetime.abort();
			microphone.unlisten();
			send({ type: 'listen_stop' });
			onMicStatusChange('idle');
		};
	}, [listenMode, isConnected, getMic, send, onMicStatusChange]);

	const chooseListenMode = useCallback(
		(mode: ListenMode) => {
			setListenMode(mode);

			// Back to the raw mic for push-to-talk, open before the next press.
			if (mode === 'push') {
				void getMic()
					.ensure()
					.catch(() => {
						// The next press opens it again and reports a denial.
					});
			}
		},
		[getMic],
	);

	return { listenMode, listenModeRef, chooseListenMode };
};

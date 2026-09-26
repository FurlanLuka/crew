import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage } from '../shared/protocol.js';
import type { Mic } from './audio.js';
import type { ListenOff, MicStatus } from './types.js';

const HANDS_FREE_STORAGE_KEY = 'voiceos.handsFree';

const readHandsFree = (): boolean => {
	try {
		// Per tab: a second tab must not start listening on its own when it opens.
		return sessionStorage.getItem(HANDS_FREE_STORAGE_KEY) === '1';
	} catch {
		return false;
	}
};

const writeHandsFree = (isOn: boolean): void => {
	try {
		sessionStorage.setItem(HANDS_FREE_STORAGE_KEY, isOn ? '1' : '0');
	} catch {
		// Private mode or blocked storage: hands-free just is not remembered.
	}
};

export interface UseHandsFreeParams {
	isConnected: boolean;
	listenOff: ListenOff | null;
	getMic: () => Mic;
	send: (message: ClientMessage) => void;
	onMicStatusChange: (mic: MicStatus) => void;
}

export const useHandsFree = ({
	isConnected,
	listenOff,
	getMic,
	send,
	onMicStatusChange,
}: UseHandsFreeParams) => {
	const [handsFree, setHandsFree] = useState(readHandsFree);
	// The ref lets handlers see the latest value without being recreated.
	const handsFreeRef = useRef(handsFree);
	handsFreeRef.current = handsFree;

	useEffect(() => writeHandsFree(handsFree), [handsFree]);

	useEffect(() => {
		if (listenOff) {
			setHandsFree(false);
		}
	}, [listenOff]);

	// Announced on every (re)connect: a new socket, or a restarted server, knows nothing of it.
	useEffect(() => {
		if (!handsFree || !isConnected) {
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

				microphone.listen(() => send({ type: 'listen_start', sampleRate }));
				onMicStatusChange('live');
			})
			.catch(() => {
				if (lifetime.signal.aborted) {
					return;
				}

				setHandsFree(false);
				onMicStatusChange('denied');
			});

		return () => {
			lifetime.abort();
			microphone.unlisten();
			send({ type: 'listen_stop' });
			onMicStatusChange('idle');
		};
	}, [handsFree, isConnected, getMic, send, onMicStatusChange]);

	const toggleHandsFree = useCallback(() => {
		const isTurningOn = !handsFreeRef.current;
		setHandsFree(isTurningOn);

		// Back to the raw mic for push-to-talk, open before the next press.
		if (!isTurningOn) {
			void getMic()
				.ensure()
				.catch(() => {
					// The next press opens it again and reports a denial.
				});
		}
	}, [getMic]);

	return { handsFree, handsFreeRef, toggleHandsFree };
};

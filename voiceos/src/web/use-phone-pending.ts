// The phone's screen moves at once: a switch_view also shows its view locally until the server's
// state catches up (phone-nav.ts: addPending, advancePending, readShownView). Everything on the phone
// that changes screens dispatches through this, so the rows, back, the swipe and the phone's back
// gesture never wait.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { State } from '../shared/protocol.js';
import { toShownView } from '../state/active.js';
import {
	addPending,
	advancePending,
	PENDING_MS,
	type PendingView,
	readShownView,
	readViewKey,
} from './phone-nav.js';
import type { Dispatch } from './types.js';

export const usePendingView = (
	serverState: State,
	dispatch: Dispatch,
): { state: State; dispatch: Dispatch } => {
	const [pending, setPending] = useState<PendingView | null>(null);
	const serverRef = useRef(serverState);
	serverRef.current = serverState;
	const serverKey = readViewKey(serverState.view);

	const navigate = useCallback<Dispatch>(
		(action) => {
			if (action.type === 'switch_view') {
				const server = serverRef.current;

				// Shaped as the server will show it: an active session opened from Home goes back to Home.
				setPending((current) =>
					addPending(current, toShownView(server, action.view), readViewKey(server.view)),
				);
			}

			dispatch(action);
		},
		[dispatch],
	);

	// Before paint: the screen never shows a move the server has just overruled.
	useLayoutEffect(() => {
		setPending((current) => advancePending(current, serverKey));
	}, [serverKey]);

	useEffect(() => {
		if (!pending) {
			return;
		}

		// A move the server never answered is undone, and nothing later queues behind it.
		const timer = setTimeout(() => setPending(null), PENDING_MS);

		return () => clearTimeout(timer);
	}, [pending]);

	const view = readShownView(pending, serverState.view);

	return {
		state: view === serverState.view ? serverState : { ...serverState, view },
		dispatch: navigate,
	};
};

// The phone's back button (Android's gesture, Safari's edge swipe in a tab): a screen deeper than Home
// holds one history entry, at the same address, so the phone's link keeps its key; going back
// through the browser pops it and goes up a level. Home with an entry still held gives it back, so a
// back from Home leaves the app as it should.
import { useEffect, useRef } from 'react';

const MARK = 'voiceosPhone';

const isHeld = (): boolean =>
	typeof history.state === 'object' && history.state !== null && MARK in history.state;

export const usePhoneHistory = (depth: number, onBack: () => unknown): void => {
	const onBackRef = useRef(onBack);
	onBackRef.current = onBack;
	const depthRef = useRef(depth);
	depthRef.current = depth;
	// Our own history.back() pops too, and may land after the next screen opened: never a back.
	const ownPops = useRef(0);

	useEffect(() => {
		if (depth > 0 && !isHeld()) {
			history.pushState({ [MARK]: true }, '', window.location.href);
		} else if (depth === 0 && isHeld()) {
			ownPops.current++;
			history.back();
		}
	}, [depth]);

	useEffect(() => {
		const handlePop = () => {
			if (ownPops.current > 0) {
				ownPops.current--;

				// A screen opened while it was on its way: it holds an entry again.
				if (depthRef.current > 0 && !isHeld()) {
					history.pushState({ [MARK]: true }, '', window.location.href);
				}

				return;
			}

			if (depthRef.current > 0) {
				onBackRef.current();

				// The entry is gone; a back the server never applies (no connection) would leave the next
				// one nothing to pop but the app itself.
				if (!isHeld()) {
					history.pushState({ [MARK]: true }, '', window.location.href);
				}
			}
		};

		window.addEventListener('popstate', handlePop);

		return () => window.removeEventListener('popstate', handlePop);
	}, []);
};

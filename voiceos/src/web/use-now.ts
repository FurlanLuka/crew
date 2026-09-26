import { useEffect, useState } from 'react';

const NOW_TICK_MS = 30_000;

export const useNow = (tickMs = NOW_TICK_MS): number => {
	// Relative times and "remembered" dimming move with the clock, not only with state.
	const [now, setNow] = useState(Date.now());

	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), tickMs);

		return () => clearInterval(timer);
	}, [tickMs]);

	return now;
};

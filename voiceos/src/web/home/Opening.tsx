// crew's opening: the wordmark fades up on black, one line under it, then it dissolves into Home.
// Once per load, about 2.5 s; skipped with reduced motion. Never takes a click. It is also what a
// fresh load shows while it waits for crew's server: the page behind it arrives under the title,
// never a "Connecting…" card that flashes before it.
import { useEffect, useRef, useState } from 'react';

const OUT_AT_MS = 2000;
// The dissolve: from "out" until it is gone.
const DISSOLVE_MS = 800;

export const isReducedMotion = (): boolean =>
	typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

interface OpeningProps {
	// crew's server has not answered yet: the title stays until it has.
	isHeld?: boolean;
	// It is gone: the page shows it once per load.
	onDone?: () => void;
}

export const Opening = ({ isHeld = false, onDone }: OpeningProps) => {
	const isReduced = isReducedMotion();
	// Reduced motion: no opening at all, unless it is what holds the screen while crew connects (then
	// it shows still: its fades only run with motion).
	const [phase, setPhase] = useState<'in' | 'out' | 'gone'>(() =>
		isReduced && !isHeld ? 'gone' : 'in',
	);
	const shownAt = useRef(Date.now());

	useEffect(() => {
		if (isHeld || phase === 'gone') {
			return;
		}

		// Reduced motion: no fade, it goes as soon as the page is there.
		if (isReduced) {
			setPhase('gone');

			return;
		}

		// At least the full opening, counted from when it first showed.
		const outIn = Math.max(0, OUT_AT_MS - (Date.now() - shownAt.current));
		const out = setTimeout(() => setPhase('out'), outIn);
		const gone = setTimeout(() => setPhase('gone'), outIn + DISSOLVE_MS);

		return () => {
			clearTimeout(out);
			clearTimeout(gone);
		};
	}, [isHeld]);

	useEffect(() => {
		if (phase === 'gone') {
			onDone?.();
		}
	}, [phase, onDone]);

	if (phase === 'gone') {
		return null;
	}

	return (
		<div className={`intro ${phase === 'out' ? 'out' : ''}`} aria-hidden="true">
			<div className="intro-mark">
				<div className="wordmark">crew</div>
				<div className="tagline">your sessions, every machine</div>
			</div>
		</div>
	);
};

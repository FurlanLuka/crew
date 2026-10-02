// crew's opening: the wordmark fades up on black, one line under it, then it dissolves into Home.
// Once per load, about 2.5 s; skipped with reduced motion. Never takes a click.
import { useEffect, useState } from 'react';

const OUT_AT_MS = 2000;
const GONE_AT_MS = 2800;

export const isReducedMotion = (): boolean =>
	typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export const Opening = () => {
	const [phase, setPhase] = useState<'in' | 'out' | 'gone'>(() =>
		isReducedMotion() ? 'gone' : 'in',
	);

	useEffect(() => {
		if (phase === 'gone') {
			return;
		}

		const out = setTimeout(() => setPhase('out'), OUT_AT_MS);
		const gone = setTimeout(() => setPhase('gone'), GONE_AT_MS);

		return () => {
			clearTimeout(out);
			clearTimeout(gone);
		};
	}, []);

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

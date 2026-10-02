// Choosing Voice OS: "Voice OS" fades up as a wordmark, set like crew's own (no icon), then
// dissolves into it. About 1.5 s; never shown with reduced motion.
import { useEffect, useState } from 'react';

const OUT_AT_MS = 1500;
const GONE_AT_MS = 2250;

interface VoiceMomentProps {
	onDone: () => void;
}

export const VoiceMoment = ({ onDone }: VoiceMomentProps) => {
	const [isOut, setIsOut] = useState(false);

	useEffect(() => {
		const out = setTimeout(() => setIsOut(true), OUT_AT_MS);
		const gone = setTimeout(onDone, GONE_AT_MS);

		return () => {
			clearTimeout(out);
			clearTimeout(gone);
		};
	}, [onDone]);

	return (
		<div className={`intro vo-moment ${isOut ? 'out' : ''}`} aria-hidden="true">
			<div className="intro-mark">
				<div className="wordmark">Voice OS</div>
			</div>
		</div>
	);
};

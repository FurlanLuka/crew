// Choosing Voice OS: "Voice OS" fades up as a wordmark, set like crew's own (no icon), then
// dissolves into it. About 1.5 s; never shown with reduced motion. With voice off a line is drawn
// through "Voice" once the wordmark is up, and it stays a moment longer to be seen.
import { useEffect, useState } from 'react';

const OUT_AT_MS = 1500;
const GONE_AT_MS = 2250;
const STRUCK_EXTRA_MS = 500;

interface VoiceMomentProps {
	isStruck?: boolean;
	onDone: () => void;
}

export const VoiceMoment = ({ isStruck = false, onDone }: VoiceMomentProps) => {
	const [isOut, setIsOut] = useState(false);

	useEffect(() => {
		const extra = isStruck ? STRUCK_EXTRA_MS : 0;
		const out = setTimeout(() => setIsOut(true), OUT_AT_MS + extra);
		const gone = setTimeout(onDone, GONE_AT_MS + extra);

		return () => {
			clearTimeout(out);
			clearTimeout(gone);
		};
	}, [isStruck, onDone]);

	return (
		<div className={`intro vo-moment ${isOut ? 'out' : ''}`} aria-hidden="true">
			<div className="intro-mark">
				<div className="wordmark">{isStruck ? <s className="struck">Voice</s> : 'Voice'} OS</div>
			</div>
		</div>
	);
};

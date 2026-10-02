import type { SpokenLine, State } from '../../shared/protocol.js';

const SPOKEN_LINE_SHOWN_MS = 60_000;

interface LastSpokenLineProps {
	state: State;
}

export const isShownOn = (line: SpokenLine, view: State['view']): boolean =>
	// On a session's screen another session's narration reads as this one's; Voice OS's own words,
	// alerts and the meanwhile line (an update about elsewhere, "… Switch there?") are for wherever
	// the developer is.
	view.kind !== 'session' ||
	line.source !== 'narrator' ||
	line.isUpdate === true ||
	!line.ref ||
	line.ref === view.ref;

export const LastSpokenLine = ({ state }: LastSpokenLineProps) => {
	const lastSpoken = state.spoken.findLast((line) => isShownOn(line, state.view));

	if (!lastSpoken || Date.now() - lastSpoken.at > SPOKEN_LINE_SHOWN_MS) {
		return null;
	}

	return (
		<div className="vo-spoken speech">
			<span className="label">Spoken</span>
			<p className="said">{lastSpoken.text}</p>
		</div>
	);
};

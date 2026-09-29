import type { SpokenLine, State } from '../../shared/protocol.js';

const SPOKEN_LINE_SHOWN_MS = 60_000;

interface LastSpokenLineProps {
	state: State;
}

const isShownOn = (line: SpokenLine, view: State['view']): boolean =>
	// On a session's screen another session's narration reads as this one's; Voice OS's own words
	// and alerts are for wherever the developer is.
	view.kind !== 'session' || line.source !== 'narrator' || !line.ref || line.ref === view.ref;

export const LastSpokenLine = ({ state }: LastSpokenLineProps) => {
	const lastSpoken = state.spoken.findLast((line) => isShownOn(line, state.view));

	if (!lastSpoken || Date.now() - lastSpoken.at > SPOKEN_LINE_SHOWN_MS) {
		return <div />;
	}

	return (
		<div className="speech">
			<span className="who">spoken</span>
			<span className="said">{lastSpoken.text}</span>
		</div>
	);
};

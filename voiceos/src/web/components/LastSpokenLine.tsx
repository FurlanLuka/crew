import type { State } from '../../shared/protocol.js';

const SPOKEN_LINE_SHOWN_MS = 60_000;

interface LastSpokenLineProps {
	state: State;
}

export const LastSpokenLine = ({ state }: LastSpokenLineProps) => {
	const lastSpoken = state.spoken.at(-1);

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

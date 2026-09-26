import { GRID, isRemembered, type State, type VoiceEntry } from '../../shared/protocol.js';
import { formatAge } from '../../state/working.js';
import { formatDidLine } from '../derive.js';
import { useNow } from '../use-now.js';

interface VoicePanelProps {
	state: State;
	screen: string | null;
}

export const VoicePanel = ({ state, screen }: VoicePanelProps) => {
	const entries: VoiceEntry[] = state.voiceLog[screen ?? GRID] ?? [];
	const now = useNow();

	return (
		<section className="panel voice-log" aria-label="voice log">
			<span className="lbl">voice</span>
			{entries.length === 0 && <div className="row c-dim">nothing said here yet</div>}
			{[...entries].reverse().map((entry, index) => (
				<div
					key={`${entry.at}-${index}`}
					className={`entry ${isRemembered(entry, now) ? '' : 'old'}`}
				>
					<div className="said">
						you: {entry.utterance} <span className="el">{formatAge(now - entry.at)} ago</span>
					</div>
					{entry.did.map((did, didIndex) => (
						<div key={didIndex} className="did">
							→ {formatDidLine(did)}
						</div>
					))}
					{entry.reply && <div className="reply">◂ “{entry.reply}”</div>}
					{entry.isIgnored && <div className="did c-dim">· no reply needed</div>}
					{entry.isFailed && <div className="did c-crit">· Voice OS could not handle this</div>}
				</div>
			))}
		</section>
	);
};

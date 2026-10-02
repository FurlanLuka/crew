import { HOME_SCREEN, isRemembered, type State, type VoiceEntry } from '../../shared/protocol.js';
import { formatAge } from '../../state/working.js';
import { formatDidLine } from '../derive.js';
import { useNow } from '../use-now.js';

interface VoicePanelProps {
	state: State;
	screen: string | null;
}

export const VoicePanel = ({ state, screen }: VoicePanelProps) => {
	const entries: VoiceEntry[] = state.voiceLog[screen ?? HOME_SCREEN] ?? [];
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
					<div className="row said">
						<span>you: {entry.utterance}</span>
						<span className="el">{formatAge(now - entry.at)} ago</span>
					</div>
					{entry.did.map((did, didIndex) => (
						<div key={didIndex} className="row">
							<span>→ {formatDidLine(did)}</span>
						</div>
					))}
					{entry.reply && (
						<div className="row">
							<span>◂ “{entry.reply}”</span>
						</div>
					)}
					{entry.isIgnored && (
						<div className="row c-dim">
							<span>· no reply needed</span>
						</div>
					)}
					{entry.isFailed && (
						<div className="row c-crit">
							<span>· Voice OS could not handle this</span>
						</div>
					)}
				</div>
			))}
		</section>
	);
};

// Voice off and on in one click: the word "voice", struck through while it is off. The top bar's,
// and where the mic sits while voice is off.
import type { Dispatch } from '../types.js';

interface VoiceToggleProps {
	isOff: boolean;
	dispatch: Dispatch;
	className?: string;
}

export const VoiceToggle = ({ isOff, dispatch, className = '' }: VoiceToggleProps) => (
	<button
		type="button"
		className={`vo-voice ${isOff ? 'off' : ''} ${className}`}
		aria-label={isOff ? 'Turn voice on' : 'Mute voice'}
		title={
			isOff
				? 'Voice is off: nothing listens or speaks, typing still works. Click to turn it on.'
				: 'Mute voice: nothing listens or speaks, typing still works'
		}
		onClick={() => dispatch({ type: 'set_voice_off', voiceOff: !isOff })}
	>
		<span className="vo-voice-word">voice</span>
	</button>
);

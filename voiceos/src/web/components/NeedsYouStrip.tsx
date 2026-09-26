import type { Session } from '../../shared/protocol.js';
import { stripSessionName } from '../../shared/spoken.js';
import type { Dispatch } from '../types.js';

interface NeedsYouStripProps {
	session: Session;
	dispatch: Dispatch;
}

export const NeedsYouStrip = ({ session, dispatch }: NeedsYouStripProps) => {
	if (!session.needsUser) {
		return null;
	}

	return (
		<section className="strip amber" aria-label="needs you">
			<span className="lbl c-amber">needs you</span>
			<span className="say">{stripSessionName(session.needsUser.text)}</span>
			<button
				type="button"
				className="btn"
				onClick={() => dispatch({ type: 'dismiss_needs_user', ref: session.ref })}
			>
				Dismiss
			</button>
		</section>
	);
};

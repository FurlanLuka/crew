import type { State } from '../../shared/protocol.js';
import type { Dispatch } from '../types.js';
import { Tile } from './Tile.js';
import { VoicePanel } from './VoicePanel.js';

interface GridProps {
	state: State;
	dispatch: Dispatch;
}

export const Grid = ({ state, dispatch }: GridProps) => {
	if (state.order.length === 0) {
		return (
			<div className="empty">
				No crew worktrees yet. Create one with <code>crew add worktree</code>, or ask the voiceos
				session.
			</div>
		);
	}

	return (
		<main className="mission">
			<div className="grid">
				{state.order.map((ref) => {
					const session = state.sessions[ref];

					return session ? (
						<Tile key={ref} session={session} state={state} dispatch={dispatch} />
					) : null;
				})}
			</div>
			<aside className="side">
				<VoicePanel state={state} screen={null} />
			</aside>
		</main>
	);
};

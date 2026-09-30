import { LOCAL_MACHINE, readMachine } from '../../shared/machine-ref.js';
import type { State } from '../../shared/protocol.js';
import type { Dispatch } from '../types.js';
import { Tile } from './Tile.js';
import { NotesPanel } from './NotesPanel.js';
import { VoicePanel } from './VoicePanel.js';
import { ElsewherePanel } from './ElsewherePanel.js';

interface GridProps {
	state: State;
	dispatch: Dispatch;
	// One machine's sessions (LOCAL_MACHINE for this Mac); absent for every session.
	machine?: string;
}

const EmptyGrid = ({ state, machine }: { state: State; machine?: string }) => {
	const remote = machine && machine !== LOCAL_MACHINE ? state.machines[machine] : undefined;

	if (remote) {
		return (
			<div className="empty">
				No worktrees on {remote.name} yet.{' '}
				{remote.status === 'connected'
					? `Ask ${remote.name}'s setup session to create one.`
					: (remote.detail ?? `${remote.name} is out of reach.`)}
			</div>
		);
	}

	return (
		<div className="empty">
			No crew worktrees yet. Create one with <code>crew add worktree</code>, or ask the setup
			session.
		</div>
	);
};

export const Grid = ({ state, dispatch, machine }: GridProps) => {
	const refs = machine ? state.order.filter((ref) => readMachine(ref) === machine) : state.order;

	return (
		<main className="mission">
			{refs.length === 0 ? (
				<EmptyGrid state={state} machine={machine} />
			) : (
				<div className="grid">
					{refs.map((ref) => {
						const session = state.sessions[ref];

						return session ? (
							<Tile key={ref} session={session} state={state} dispatch={dispatch} />
						) : null;
					})}
				</div>
			)}
			<aside className="side">
				{machine && (
					<ElsewherePanel state={state} screen={null} dispatch={dispatch} gridMachine={machine} />
				)}
				<VoicePanel state={state} screen={null} />
				<NotesPanel state={state} screen={null} />
			</aside>
		</main>
	);
};

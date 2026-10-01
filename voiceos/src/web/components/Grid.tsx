import { LOCAL_MACHINE, readMachine } from '../../shared/machine-ref.js';
import type { State } from '../../shared/protocol.js';
import type { Dispatch } from '../types.js';
import { listActiveTiles } from '../derive.js';
import { MissingTile, Tile } from './Tile.js';
import { NotesPanel } from './NotesPanel.js';
import { VoicePanel } from './VoicePanel.js';
import { ElsewherePanel } from './ElsewherePanel.js';

interface GridProps {
	state: State;
	dispatch: Dispatch;
	// One machine's sessions (LOCAL_MACHINE for this Mac); absent for every session.
	machine?: string;
	// The active sessions, from every machine, setup first; machine is ignored.
	isActiveView?: boolean;
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

const ActiveTiles = ({ state, dispatch }: { state: State; dispatch: Dispatch }) => {
	const tiles = listActiveTiles(state);

	if (tiles.length === 0) {
		return (
			<div className="empty">
				Nothing active. Activate a tile, or say “activate” and the session's name.
			</div>
		);
	}

	return (
		<div className="grid">
			{tiles.map((tile) =>
				'session' in tile ? (
					<Tile key={tile.ref} session={tile.session} state={state} dispatch={dispatch} />
				) : (
					<MissingTile
						key={tile.ref}
						sessionRef={tile.ref}
						text={tile.missing}
						name={state.names[tile.ref]}
						dispatch={dispatch}
					/>
				),
			)}
		</div>
	);
};

const MachineTiles = ({ state, dispatch, machine }: GridProps) => {
	const refs = machine ? state.order.filter((ref) => readMachine(ref) === machine) : state.order;

	if (refs.length === 0) {
		return <EmptyGrid state={state} machine={machine} />;
	}

	return (
		<div className="grid">
			{refs.map((ref) => {
				const session = state.sessions[ref];

				return session ? (
					<Tile key={ref} session={session} state={state} dispatch={dispatch} />
				) : null;
			})}
		</div>
	);
};

export const Grid = ({ state, dispatch, machine, isActiveView = false }: GridProps) => (
	<main className="mission">
		{isActiveView ? (
			<ActiveTiles state={state} dispatch={dispatch} />
		) : (
			<MachineTiles state={state} dispatch={dispatch} machine={machine} />
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

import { LOCAL_MACHINE, readMachine } from '../../shared/machine-ref.js';
import type { State } from '../../shared/protocol.js';
import type { Dispatch } from '../types.js';
import { listPinnedTiles } from '../derive.js';
import { MissingTile, Tile } from './Tile.js';
import { NotesPanel } from './NotesPanel.js';
import { VoicePanel } from './VoicePanel.js';
import { ElsewherePanel } from './ElsewherePanel.js';

interface GridProps {
	state: State;
	dispatch: Dispatch;
	// One machine's sessions (LOCAL_MACHINE for this Mac); absent for every session.
	machine?: string;
	// The pins, from every machine, in pin order; machine is ignored.
	isPinned?: boolean;
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

const PinnedTiles = ({ state, dispatch }: { state: State; dispatch: Dispatch }) => {
	const tiles = listPinnedTiles(state);

	if (tiles.length === 0) {
		return <div className="empty">Nothing pinned. Pin a tile, or say “pin this” on a session.</div>;
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

export const Grid = ({ state, dispatch, machine, isPinned = false }: GridProps) => (
	<main className="mission">
		{isPinned ? (
			<PinnedTiles state={state} dispatch={dispatch} />
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

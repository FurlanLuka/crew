// A plain Claude session: a machine, a folder there (home when empty) and a name. Made with crew on
// that machine, then activated: it starts as soon as it is listed. A real modal, like the sub-agent
// transcript: Esc closes it, and the page's own Esc and Space leave it alone.
import { type FormEvent, useState } from 'react';
import {
	CHAT_WORKSPACE,
	isChatRef,
	LOCAL_MACHINE,
	readMachine,
	refOn,
} from '../../shared/machine-ref.js';
import { isMachineReachable, listMachineIds, readMachineTitle } from '../../shared/machines.js';
import type { State } from '../../shared/protocol.js';
import { findNamedRef, MAX_NAME_LENGTH } from '../../state/names.js';
import { isOk, readCrewLine, runCrew } from '../setup/api.js';
import type { Dispatch } from '../types.js';

interface NewSessionDialogProps {
	state: State;
	// The machine it opens on; the developer can pick another.
	machine: string;
	dispatch: Dispatch;
	// line: what to show once it closed ("Started research on Build box."); empty when cancelled.
	onClose: (line: string) => void;
}

// The folders already used for plain sessions on a machine: the likely next ones, real paths only.
export const listRecentFolders = (state: State, machine: string): string[] => [
	...new Set(
		Object.values(state.sessions)
			.filter((session) => isChatRef(session.ref) && readMachine(session.ref) === machine)
			.map((session) => session.cwd),
	),
];

// This Mac always; another machine only while it can take the command.
const listOfferedMachines = (state: State): string[] =>
	listMachineIds(state).filter((id) => id === LOCAL_MACHINE || isMachineReachable(state, id));

export const NewSessionDialog = ({ state, machine, dispatch, onClose }: NewSessionDialogProps) => {
	const offered = listOfferedMachines(state);
	const [target, setTarget] = useState(offered.includes(machine) ? machine : LOCAL_MACHINE);
	const [dir, setDir] = useState('');
	const [name, setName] = useState('');
	const [line, setLine] = useState<string | null>(null);
	const [isBusy, setIsBusy] = useState(false);
	const title = readMachineTitle(state, target);

	const start = async (event: FormEvent) => {
		event.preventDefault();

		// Two sessions under one name would leave "ask research" guessing.
		if (name.trim() && findNamedRef(state, name.trim())) {
			setLine(`A session is already called ${name.trim()}.`);

			return;
		}

		setIsBusy(true);
		const reply = await runCrew(target, {
			type: 'chat_add',
			...(dir.trim() ? { dir: dir.trim() } : {}),
			...(name.trim() ? { name: name.trim() } : {}),
		});
		setIsBusy(false);
		const added =
			isOk(reply) && 'json' in reply ? (reply.json as { id?: string } | undefined) : undefined;

		if (!added?.id) {
			setLine(readCrewLine(reply) || 'Not started.');

			return;
		}

		dispatch({ type: 'activate', ref: refOn(target, `${CHAT_WORKSPACE}/${added.id}`) });
		onClose(`Started ${name.trim() || 'a plain session'} on ${title}.`);
	};

	return (
		<dialog
			className="nsd"
			aria-label="New session"
			ref={(dialog) => {
				if (dialog && !dialog.open) {
					dialog.showModal();
				}
			}}
			// Once crew runs it is made either way: closing then would hide a session that still starts.
			onCancel={(event) => {
				if (isBusy) {
					event.preventDefault();
				}
			}}
			onClose={() => onClose('')}
		>
			<form aria-label={`New session on ${title}`} onSubmit={(event) => void start(event)}>
				<div className="nsd-head">
					<h2>New session</h2>
					<p>
						A plain Claude conversation in a folder. No worktree, no crew context. It starts active.
					</p>
				</div>
				{offered.length > 1 && (
					<fieldset className="nsd-field">
						<legend className="nsd-label">Machine</legend>
						<div className="seg nsd-machines">
							{offered.map((id) => (
								<button
									key={id}
									type="button"
									aria-pressed={target === id}
									onClick={() => setTarget(id)}
								>
									<span className="dot ok" />
									{readMachineTitle(state, id)}
								</button>
							))}
						</div>
					</fieldset>
				)}
				<label className="nsd-field">
					<span className="nsd-label">Folder</span>
					<input
						type="text"
						className="nsd-mono"
						autoComplete="off"
						placeholder="~"
						value={dir}
						onChange={(event) => setDir(event.target.value)}
					/>
				</label>
				<fieldset className="nsd-picks" aria-label="Recent folders">
					{['~', ...listRecentFolders(state, target)].map((folder) => (
						<button
							key={folder}
							type="button"
							className="nsd-pick"
							aria-pressed={(dir.trim() || '~') === folder}
							onClick={() => setDir(folder === '~' ? '' : folder)}
						>
							{folder}
						</button>
					))}
				</fieldset>
				<p className="nsd-hint">Must exist on {title}. Your home folder when left empty.</p>
				<label className="nsd-field">
					<span className="nsd-label">Name</span>
					<input
						type="text"
						autoComplete="off"
						placeholder="research"
						maxLength={MAX_NAME_LENGTH}
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
				</label>
				<p className="nsd-hint">
					What you say to reach it: “{name.trim() || 'research'}, what did you find?”
				</p>
				{line && (
					<p className="nsd-line" role="alert">
						{line}
					</p>
				)}
				<div className="nsd-actions">
					<span className="nsd-hint">Or say: “new session on {title} called research”</span>
					<button type="button" className="btn ghost" disabled={isBusy} onClick={() => onClose('')}>
						Cancel
					</button>
					<button type="submit" className="btn primary" disabled={isBusy}>
						Start session
					</button>
				</div>
			</form>
		</dialog>
	);
};

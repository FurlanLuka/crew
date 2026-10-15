// The first run's workspace step: its name and projects, then the commands that make it and its
// main worktree (or join a workspace made earlier from the terminal).
import { useState } from 'react';
import { LOCAL_MACHINE } from '../../shared/machine-ref.js';
import { isOk, useCrew, useCrewAction } from '../setup/api.js';
import { ResultLine } from '../setup/common.js';
import { TickRow, toggle } from '../setup/flow.js';
import type { CrewProject, CrewWorkspace } from '../setup/types.js';
import { planFirstWorkspace } from './first-run.js';

interface WorkspaceStepProps {
	pool: CrewProject[];
	onBack: () => void;
	onCreated: (ref: string) => void;
}

export const WorkspaceStep = ({ pool, onBack, onCreated }: WorkspaceStepProps) => {
	const workspaces = useCrew<CrewWorkspace[]>(LOCAL_MACHINE, { type: 'ls_workspaces' });
	const action = useCrewAction(LOCAL_MACHINE);
	const [name, setName] = useState<string | null>(null);
	const [unticked, setUnticked] = useState<string[]>([]);
	const workspace = (name ?? pool[0]?.name ?? '').trim();
	const members = pool.map((project) => project.name).filter((each) => !unticked.includes(each));
	const existing = (workspaces.data ?? []).find((each) => each.name === workspace);
	const commands = planFirstWorkspace({ workspace, members, existing });

	const create = async () => {
		try {
			for (const command of commands) {
				if (!isOk(await action.run(command))) {
					return;
				}
			}

			onCreated(`${workspace}/main`);
		} finally {
			// Read again either way: a join that went through before main was refused must not be sent
			// twice.
			workspaces.refresh();
		}
	};

	return (
		<div className="fr-col">
			<h1>Make a workspace</h1>
			<p className="fr-lead">
				A workspace is the projects you work on together. crew makes its first working copy,{' '}
				<b>main</b>, and that is where your first session lives.
			</p>
			<div className="fr-group fr-pad">
				<label className="field">
					<span>Name</span>
					<input
						type="text"
						autoComplete="off"
						spellCheck={false}
						value={name ?? pool[0]?.name ?? ''}
						onChange={(event) => setName(event.target.value)}
					/>
					<small>your session: {workspace || '<name>'}/main</small>
				</label>
			</div>
			<div className="fr-group">
				{pool.map((project) => (
					<TickRow
						key={project.name}
						name={project.name}
						sub={project.path ?? ''}
						side="worktree"
						isOn={!unticked.includes(project.name)}
						onToggle={() => setUnticked(toggle(unticked, project.name))}
					/>
				))}
			</div>
			<ResultLine reply={action.last && !isOk(action.last) ? action.last : null} />
			<div className="fr-actions">
				<button type="button" className="btn ghost" onClick={onBack}>
					Back
				</button>
				<button
					type="button"
					className="btn primary"
					// Which commands Create runs depends on crew's workspaces: never before they are read.
					disabled={commands.length === 0 || workspaces.data === null || action.isBusy}
					onClick={() => void create()}
				>
					{action.isBusy ? 'Creating…' : `Create ${workspace || 'workspace'}`}
				</button>
			</div>
		</div>
	);
};

// Moving to another machine: an export saved where the browser saves files, and the way to import.
import { useState } from 'react';
import type { SetupCommand } from '../../../crew/commands.js';
import { isOk, readCrewLine, runCrew, useCrew } from '../api.js';
import { CommandLine } from '../CommandLine.js';
import type { SetupContext } from '../common.js';
import type { CrewProject, CrewWorkspace } from '../types.js';

// A bundle crew wrote to stdout, saved where the browser saves files.
const saveBundle = (text: string): void => {
	const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
	const link = document.createElement('a');
	link.href = url;
	link.download = 'crew-export.json';
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

export const MoveSection = ({ ctx }: { ctx: SetupContext }) => {
	const projects = useCrew<CrewProject[]>(ctx.machine, { type: 'ls_projects' });
	const workspaces = useCrew<CrewWorkspace[]>(ctx.machine, { type: 'ls_workspaces' });
	const [isPicking, setIsPicking] = useState(false);
	const [picked, setPicked] = useState<{ projects: string[]; workspaces: string[] }>({
		projects: [],
		workspaces: [],
	});
	const [line, setLine] = useState('');
	const isAll = picked.projects.length === 0 && picked.workspaces.length === 0;
	const command: SetupCommand = isAll
		? { type: 'export', all: true }
		: {
				type: 'export',
				...(picked.projects.length ? { projects: picked.projects } : {}),
				...(picked.workspaces.length ? { workspaces: picked.workspaces } : {}),
			};

	const toggle = (kind: 'projects' | 'workspaces', name: string) =>
		setPicked({
			...picked,
			[kind]: picked[kind].includes(name)
				? picked[kind].filter((other) => other !== name)
				: [...picked[kind], name],
		});

	const exportNow = async () => {
		const reply = await runCrew(ctx.machine, command);

		if (isOk(reply)) {
			saveBundle(reply.stdout);
			setLine(readCrewLine({ ...reply, stdout: '' }) || 'Saved crew-export.json.');
		} else {
			setLine(readCrewLine(reply));
		}
	};

	return (
		<div className="cfg-sec">
			<div className="cfg-h">
				<span className="label">Move to another machine</span>
			</div>
			<p className="fail-why">
				An export holds projects (by their git remote) and which workspaces they're in. Worktrees,
				ports and pinned values stay here.
			</p>
			{isPicking && (
				<div className="picks export-picks">
					{(projects.data ?? []).map((project) => (
						<label key={`p ${project.name}`} className="pick">
							<input
								type="checkbox"
								checked={picked.projects.includes(project.name)}
								onChange={() => toggle('projects', project.name)}
							/>
							<b>{project.name}</b>
							<span className="m">project</span>
						</label>
					))}
					{(workspaces.data ?? []).map((workspace) => (
						<label key={`w ${workspace.name}`} className="pick">
							<input
								type="checkbox"
								checked={picked.workspaces.includes(workspace.name)}
								onChange={() => toggle('workspaces', workspace.name)}
							/>
							<b>{workspace.name}</b>
							<span className="m">workspace</span>
						</label>
					))}
				</div>
			)}
			{isPicking && <CommandLine commands={[command]} />}
			<div className="row-actions">
				{isPicking ? (
					<button type="button" className="btn primary" onClick={() => void exportNow()}>
						{isAll ? 'Export everything' : 'Export these'}
					</button>
				) : (
					<button type="button" className="btn" onClick={() => setIsPicking(true)}>
						Export…
					</button>
				)}
				<button type="button" className="btn" onClick={() => ctx.go({ page: 'import' })}>
					Import…
				</button>
			</div>
			{line && <p className="result-line ok">{line}</p>}
		</div>
	);
};

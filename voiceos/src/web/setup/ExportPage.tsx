// Export: pick workspaces (their projects come along) and projects in none, then save crew's
// bundle where the browser saves files. The other machine imports it from its own Set up.
import { useState } from 'react';
import { countOf } from '../count.js';
import { isOk, readCrewLine, runCrew, useCrew } from './api.js';
import { CommandLine } from './CommandLine.js';
import { PageHead, type SetupContext } from './common.js';
import { exportCommand, listExported, listLoose, membersOf } from './export.js';
import { TickRow, toggle } from './flow.js';
import type { CrewProject, CrewWorkspace } from './types.js';

// A bundle crew wrote to stdout, saved where the browser saves files.
const saveBundle = (text: string): void => {
	const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
	const link = document.createElement('a');
	link.href = url;
	link.download = 'crew-export.json';
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

const describeRemote = (project: CrewProject | undefined): string =>
	project?.remote || 'no git remote';

export const ExportPage = ({ ctx }: { ctx: SetupContext }) => {
	const projects = useCrew<CrewProject[]>(ctx.machine, { type: 'ls_projects' });
	const workspaces = useCrew<CrewWorkspace[]>(ctx.machine, { type: 'ls_workspaces' });
	const [unpickedWorkspaces, setUnpickedWorkspaces] = useState<string[]>([]);
	const [unpickedLoose, setUnpickedLoose] = useState<string[]>([]);
	const [saved, setSaved] = useState<{ isOk: boolean; line: string } | null>(null);
	const pool = projects.data ?? [];
	const spaces = workspaces.data ?? [];
	const loose = listLoose(
		pool.map((project) => project.name),
		spaces,
	);
	const pickedWorkspaces = spaces
		.map((workspace) => workspace.name)
		.filter((name) => !unpickedWorkspaces.includes(name));
	const pickedLoose = loose.filter((name) => !unpickedLoose.includes(name));
	const exported = listExported(spaces, pickedWorkspaces, pickedLoose);
	const command = exportCommand({ workspaces: spaces, loose, pickedWorkspaces, pickedLoose });
	const byName = (name: string) => pool.find((project) => project.name === name);
	const noRemote = exported.filter((name) => !byName(name)?.remote);

	const save = async () => {
		if (!command) {
			return;
		}

		const reply = await runCrew(ctx.machine, command);

		if (isOk(reply)) {
			saveBundle(reply.stdout);
			setSaved({
				isOk: true,
				line: 'Saved crew-export.json. On the other machine: Set up › Settings › Import, or crew import crew-export.json.',
			});
		} else {
			setSaved({ isOk: false, line: readCrewLine(reply) || 'crew refused.' });
		}
	};

	return (
		<section className="page narrow move" aria-label="Export">
			<PageHead
				title="Export to another machine"
				lead="Pick workspaces and the projects in them come along. The other machine clones each project from its git remote, so nothing here is copied but the setup."
			/>
			{(spaces.length > 0 || loose.length > 0) && (
				<div className="fr-group">
					{spaces.length > 0 && (
						<div className="fr-group-h">
							<span>Workspaces and their projects</span>
							<span>worktrees stay here</span>
						</div>
					)}
					{spaces.map((workspace) => {
						const isOn = pickedWorkspaces.includes(workspace.name);

						return (
							<div key={workspace.name} className="fr-nest">
								<TickRow
									name={workspace.name}
									sub={countOf(membersOf(workspace).length, 'project')}
									side="workspace"
									isOn={isOn}
									onToggle={() => setUnpickedWorkspaces(toggle(unpickedWorkspaces, workspace.name))}
								/>
								{isOn &&
									membersOf(workspace).map((name) => {
										const remote = byName(name)?.remote;

										return (
											<div key={name} className="fr-row nested" data-member={name}>
												<span className={`dot ${remote ? 'ok' : 'ask'}`} />
												<span className="fr-row-text">
													<b>{name}</b>
													<span className="m">{remote || 'no git remote'}</span>
												</span>
												<span className={`m fr-side ${remote ? '' : 'c-warn'}`}>
													{remote ? 'by remote' : 'setup only'}
												</span>
											</div>
										);
									})}
							</div>
						);
					})}
					{loose.length > 0 && (
						<div className="fr-group-h">
							<span>Projects in no workspace</span>
						</div>
					)}
					{loose.map((name) => (
						<TickRow
							key={name}
							name={name}
							sub={describeRemote(byName(name))}
							side={byName(name)?.remote ? 'project' : 'setup only'}
							isOn={pickedLoose.includes(name)}
							onToggle={() => setUnpickedLoose(toggle(unpickedLoose, name))}
						/>
					))}
				</div>
			)}
			{projects.data && pool.length === 0 && (
				<p className="fr-lead">Nothing to export yet: this machine has no projects.</p>
			)}
			<div className="fr-group fr-facts">
				<div>
					<b>Goes with it</b>
					<span className="fr-fact-note">
						Projects by git remote, their install and env commands, dev servers and bindings, and
						which workspaces they're in.
					</span>
				</div>
				<div>
					<b>Stays on {ctx.machineTitle}</b>
					<span className="fr-fact-note">
						Worktrees, ports, worktree values and .env files. The other machine makes its own.
					</span>
				</div>
			</div>
			<CommandLine commands={[command]} />
			<div className="fr-actions">
				<span className="m">
					{exported.length
						? `${countOf(pickedWorkspaces.length, 'workspace')}, ${countOf(exported.length, 'project')}${noRemote.length ? ` · ${noRemote.join(', ')} ${noRemote.length === 1 ? 'has' : 'have'} no remote: the other machine points ${noRemote.length === 1 ? 'it' : 'them'} at a folder` : ''}`
						: 'Pick something to export.'}
				</span>
				<button
					type="button"
					className="btn primary"
					disabled={!command}
					onClick={() => void save()}
				>
					Save crew-export.json
				</button>
			</div>
			{saved && (
				<p className={`result-line ${saved.isOk ? 'ok' : 'bad'}`} role="status">
					{saved.isOk ? `✓ ${saved.line}` : `! ${saved.line}`}
				</p>
			)}
		</section>
	);
};

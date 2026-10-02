// A workspace: its projects (each with its mode) and its worktrees (with their servers).
// WorkspaceForm.tsx makes one or changes its projects.
import { useState } from 'react';
import { isOk, useCrew, useCrewAction } from './api.js';
import { Confirm, PageHead, ResultLine, type SetupContext, describeSize } from './common.js';
import { describeIssue, isNotSetUp } from './derive.js';
import type { CrewProject, CrewWorkspace, CrewWorktree } from './types.js';
import { countOf } from '../count.js';

interface WorkspacePageProps {
	ctx: SetupContext;
	name: string;
}

export const WorkspacePage = ({ ctx, name }: WorkspacePageProps) => {
	const workspaces = useCrew<CrewWorkspace[]>(ctx.machine, { type: 'ls_workspaces' });
	const worktrees = useCrew<CrewWorktree[]>(
		ctx.machine,
		{ type: 'ls_worktrees', workspace: name, size: true },
		{ pollMs: 4000 },
	);
	const projects = useCrew<CrewProject[]>(ctx.machine, { type: 'ls_projects' });
	const action = useCrewAction(ctx.machine);
	const [removing, setRemoving] = useState<string | null>(null);
	const [isRemovingAll, setIsRemovingAll] = useState(false);
	const workspace = workspaces.data?.find((row) => row.name === name);
	const rows = (worktrees.data ?? []).filter((row) => row.ref.startsWith(`${name}/`));

	if (workspaces.data && !workspace) {
		return (
			<section className="page">
				<PageHead title={name} lead={`No workspace called ${name} on ${ctx.machineTitle}.`} />
			</section>
		);
	}

	return (
		<section className="page" aria-label={`Workspace ${name}`}>
			<PageHead
				title={name}
				lead={
					workspace?.flat
						? 'From before crew 2.0: migrate it in Settings before adding worktrees.'
						: 'Projects worked on together. Each worktree gets a copy of every one, wired to each other.'
				}
			>
				<button
					type="button"
					className="btn"
					onClick={() => ctx.go({ page: 'workspace-edit', name })}
				>
					Add or remove projects
				</button>
				<button
					type="button"
					className="btn primary"
					onClick={() => ctx.go({ page: 'worktree-new', workspace: name })}
				>
					New worktree
				</button>
			</PageHead>
			<div className="label">Projects</div>
			<div className="box">
				{(workspace?.projects ?? []).map((member) => {
					const project = projects.data?.find((row) => row.name === member.name);
					const isReady = project && !isNotSetUp(project);

					return (
						<div key={member.name} className="box-row" data-project={member.name}>
							<span className={`dot ${isReady ? 'ok' : 'ring'}`} />
							<span className="sub">
								<b>{member.name}</b>
								<span className="m">
									{member.mode} mode
									{project?.dev_servers?.length
										? ` · ${project.dev_servers.map((server) => server.name).join(', ')}`
										: ''}
								</span>
							</span>
							<span className="row-actions">
								<span className={`chip ${isReady ? 'ok' : ''}`}>
									{isReady ? 'set up' : 'not set up'}
								</span>
								<button
									type="button"
									className="x"
									aria-label={`Take ${member.name} out of ${name}`}
									onClick={() => setRemoving(member.name)}
								>
									×
								</button>
							</span>
						</div>
					);
				})}
			</div>
			{removing && (
				<Confirm
					title={`Take ${removing} out of ${name}?`}
					why={
						<p className="fail-why">
							Every worktree of {name} loses its {removing} copy
							{rows.length ? `: ${rows.map((row) => row.ref.split('/')[1]).join(', ')}` : ''}. Their
							checkouts go to the trash; commits not on the base stay in git's reflog.
						</p>
					}
					command={{
						type: 'rm_workspace_project',
						workspace: name,
						project: removing,
						confirm: true,
					}}
					dryRun={{ type: 'rm_workspace_project_dry_run', workspace: name, project: removing }}
					machine={ctx.machine}
					actionLabel="Take it out"
					run={action.run}
					onCancel={() => setRemoving(null)}
					onDone={() => {
						setRemoving(null);
						workspaces.refresh();
						worktrees.refresh();
					}}
				/>
			)}
			<div className="label">Worktrees</div>
			<div className="box">
				{rows.length === 0 && (
					<div className="box-row">
						<span className="dot ring" />
						<span className="sub">
							<b>No worktrees yet</b>
							<span className="m">
								New worktree checks out every project on its own branch and ports.
							</span>
						</span>
					</div>
				)}
				{rows.map((row) => {
					const issue = row.issues?.[0];
					const short = row.ref.split('/')[1] ?? row.ref;
					const size = describeSize(row.size_bytes);
					const status = issue
						? describeIssue(issue)
						: row.installing
							? 'installing…'
							: row.dev_running
								? 'servers running'
								: 'stopped';

					return (
						<button
							type="button"
							key={row.ref}
							className="box-row as-link"
							data-ref={row.ref}
							onClick={() =>
								ctx.go(
									row.installing
										? { page: 'progress', ref: row.ref }
										: { page: 'worktree', ref: row.ref },
								)
							}
						>
							<span
								className={`dot ${issue ? 'ask' : row.installing || row.dev_running ? 'run' : 'ring'}`}
							/>
							<span className="sub">
								<b>{short}</b>
								<span className="m">{[status, size].filter(Boolean).join(' · ')}</span>
							</span>
							<span
								className={`chip ${issue ? 'ask' : row.installing ? 'run' : row.dev_running ? 'ok' : ''}`}
							>
								{issue
									? 'needs you'
									: row.installing
										? 'installing'
										: row.dev_running
											? 'running'
											: 'stopped'}
							</span>
						</button>
					);
				})}
			</div>
			<ResultLine reply={action.last && !isOk(action.last) ? action.last : null} />
			{isRemovingAll ? (
				<Confirm
					title={`Remove ${name}?`}
					why={
						<p className="fail-why">
							{rows.length
								? `Its ${countOf(rows.length, 'worktree goes', 'worktrees go')} to the trash; commits not on the base stay in git's reflog.`
								: 'It has no worktrees.'}{' '}
							The projects stay on {ctx.machineTitle}.
						</p>
					}
					command={{ type: 'rm_workspace', workspace: name, confirm: true }}
					machine={ctx.machine}
					actionLabel="Remove workspace"
					run={action.run}
					onCancel={() => setIsRemovingAll(false)}
					onDone={() => ctx.go({ page: 'board', tab: 'workspaces' })}
				/>
			) : (
				<div className="row-actions">
					<button type="button" className="btn danger" onClick={() => setIsRemovingAll(true)}>
						Remove workspace
					</button>
				</div>
			)}
		</section>
	);
};

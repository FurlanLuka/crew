// A project on this machine: what crew recorded (install, dev servers, environment), one line per
// fact, its check, and its removal. AddProject.tsx is the form that records a new one.
import { type ReactNode, useState } from 'react';
import { useCrew, useCrewAction } from './api.js';
import {
	Confirm,
	FailBlock,
	PageHead,
	ResultLine,
	type SetupContext,
	formatAgo,
} from './common.js';
import { describeBindingSource } from './environment.js';
import { describeCheckAction, describeStages, listWorkspacesOf, readCheck } from './derive.js';
import { readLogText } from './readers.js';
import type { CrewCheckStatus, CrewProject, CrewWorkspace, CrewWorktree } from './types.js';

interface ProjectPageProps {
	ctx: SetupContext;
	name: string;
}

export const ProjectPage = ({ ctx, name }: ProjectPageProps) => {
	const projects = useCrew<CrewProject[]>(ctx.machine, { type: 'ls_projects' });
	const worktrees = useCrew<CrewWorktree[]>(ctx.machine, { type: 'ls_worktrees' });
	const workspaces = useCrew<CrewWorkspace[]>(ctx.machine, { type: 'ls_workspaces' });
	const action = useCrewAction(ctx.machine);
	const [isRemoving, setIsRemoving] = useState(false);
	const [keepClone, setKeepClone] = useState(false);
	const [isLogShown, setIsLogShown] = useState(false);
	const checkLog = useCrew<unknown>(
		ctx.machine,
		isLogShown ? { type: 'setup_logs', ref: `check/${name}`, project: name, lines: 200 } : null,
	);
	const check = useCrew<CrewCheckStatus>(ctx.machine, { type: 'check_status', project: name });
	const project = projects.data?.find((candidate) => candidate.name === name);
	const checked = readCheck(check.data, name, worktrees.data ?? []);
	const { failure } = checked;
	const memberOf = listWorkspacesOf(workspaces.data ?? [], name);
	const checkAction = describeCheckAction(checked.state);

	if (projects.data && !project) {
		return (
			<section className="page">
				<PageHead title={name} lead={`No project called ${name} on ${ctx.machineTitle}.`} />
				<div className="row-actions">
					<button
						type="button"
						className="btn"
						onClick={() => ctx.go({ page: 'board', tab: 'projects' })}
					>
						Back to the board
					</button>
				</div>
			</section>
		);
	}

	return (
		<section className="page" aria-label={`Project ${name}`}>
			<PageHead
				title={name}
				lead={
					failure ? (
						<>
							<span className="c-crit">Check failed</span> at {failure.stage}.
						</>
					) : checked.state === 'passed' ? (
						<>
							<span className="c-good">Ready.</span> Its check passed{' '}
							{formatAgo(checked.at ?? undefined)}.
						</>
					) : (
						<>
							Not checked yet: <b>{checkAction}</b> proves it reproduces from nothing.
						</>
					)
				}
			>
				<button
					type="button"
					className="btn"
					onClick={() => ctx.go({ page: 'project-edit', name })}
				>
					Edit setup
				</button>
				<button type="button" className="btn" onClick={() => ctx.askClaude(`In ${name}, `)}>
					Ask Claude
				</button>
				<button type="button" className="btn" onClick={() => ctx.go({ page: 'check', name })}>
					{checkAction}
				</button>
			</PageHead>
			{failure && (
				<FailBlock
					title="Check failed"
					when={`at ${failure.stage}`}
					steps={describeStages(failure.stage)}
					log={failure.detail}
					why="Nothing else changed: its worktrees keep their code, and the project stays as it was set up."
				>
					<button
						type="button"
						className="btn primary"
						onClick={() =>
							ctx.askClaude(
								`Fix ${name}: its check failed at ${failure.stage}. ${failure.detail.split('\n')[0] ?? ''}`,
							)
						}
					>
						Fix with Claude
					</button>
					<button
						type="button"
						className="btn"
						onClick={() => ctx.go({ page: 'project-edit', name })}
					>
						Edit setup
					</button>
					<button type="button" className="btn" onClick={() => ctx.go({ page: 'check', name })}>
						Check again
					</button>
					<button type="button" className="btn ghost" onClick={() => setIsLogShown(!isLogShown)}>
						{isLogShown ? 'Hide full log' : 'Full log'}
					</button>
				</FailBlock>
			)}
			{isLogShown && checkLog.reply && (
				<pre className="log big">{readLogText(checkLog.data) || checkLog.reply.stderr}</pre>
			)}
			{project && (
				<ProjectFacts project={project} workspaces={memberOf.map((workspace) => workspace.name)} />
			)}
			<ResultLine reply={action.last} />
			{isRemoving ? (
				<Confirm
					title={`Remove ${name} from ${ctx.machineTitle}?`}
					why={
						<>
							<p className="fail-why">
								crew forgets {name}.{' '}
								{keepClone
									? 'Its checkout stays where it is.'
									: 'A checkout crew cloned goes to the trash; a folder you added is never moved.'}{' '}
								crew refuses while a workspace still has it.
							</p>
							<label className="check-line">
								<input
									type="checkbox"
									checked={keepClone}
									onChange={(event) => setKeepClone(event.target.checked)}
								/>
								Keep the clone
							</label>
						</>
					}
					command={{
						type: 'rm_project',
						name,
						confirm: true,
						...(keepClone ? { keep_clone: true } : {}),
					}}
					machine={ctx.machine}
					actionLabel="Remove project"
					run={action.run}
					onCancel={() => setIsRemoving(false)}
					onDone={() => ctx.go({ page: 'board', tab: 'projects' })}
				/>
			) : (
				<div className="row-actions">
					<button type="button" className="btn danger" onClick={() => setIsRemoving(true)}>
						Remove project
					</button>
				</div>
			)}
		</section>
	);
};

interface Fact {
	key: string;
	label: string;
	value: ReactNode;
	// The whole value, for the tooltip of a line cut short.
	title: string;
	isDim?: boolean;
}

const listFacts = (project: CrewProject, workspaces: string[]): Fact[] => {
	const servers = project.dev_servers ?? [];
	const bindings = project.bindings ?? [];

	return [
		{
			key: 'install',
			label: 'Install',
			value: project.setup ? <code>{project.setup}</code> : 'detected from the lockfile',
			title: project.setup ?? 'detected from the lockfile',
			isDim: !project.setup,
		},
		...(project.env_cmd
			? [
					{
						key: 'env-cmd',
						label: 'Env command',
						value: <code>{project.env_cmd}</code>,
						title: project.env_cmd,
					},
				]
			: []),
		...(servers.length
			? servers.map((server) => {
					const where = [
						server.port ? `:${server.port}` : 'no port',
						server.dir ? `in ${server.dir}` : '',
					]
						.filter(Boolean)
						.join(' · ');

					return {
						key: `server ${server.name}`,
						label: 'Dev server',
						value: (
							<>
								<b>{server.name}</b> <code>{server.command}</code>{' '}
								<span className="m">{where}</span>
							</>
						),
						title: `${server.name} · ${server.command} · ${where}`,
					};
				})
			: [{ key: 'servers', label: 'Dev servers', value: 'none', title: 'none', isDim: true }]),
		...(bindings.length
			? bindings.map((binding) => {
					const source = describeBindingSource(binding.value);
					const scope = binding.server ? ` · ${binding.server} only` : '';

					return {
						key: `binding ${binding.var} ${binding.server ?? ''}`,
						label: 'Environment',
						value: (
							<>
								<code>{binding.var}</code> ← {source}
								{scope && <span className="m">{scope}</span>}
							</>
						),
						title: `${binding.var} ← ${source}${scope}`,
					};
				})
			: [
					{
						key: 'environment',
						label: 'Environment',
						value: 'nothing set by crew',
						title: 'nothing set by crew',
						isDim: true,
					},
				]),
		{
			key: 'workspaces',
			label: 'Workspaces',
			value: workspaces.length ? workspaces.join(', ') : 'none',
			title: workspaces.join(', ') || 'none',
			isDim: !workspaces.length,
		},
		{
			key: 'source',
			label: 'Source',
			value: project.remote || 'no git remote',
			title: project.remote || 'no git remote',
			isDim: !project.remote,
		},
		...(project.path
			? [{ key: 'path', label: 'Path', value: project.path, title: project.path }]
			: []),
	];
};

// What crew recorded, one line per fact (one per dev server, one per binding): long values end in
// an ellipsis, the whole value in the tooltip.
const ProjectFacts = ({ project, workspaces }: { project: CrewProject; workspaces: string[] }) => (
	<div className="matrix-wrap">
		<table className="matrix facts-table" aria-label="What crew recorded">
			<colgroup>
				<col className="c-label" />
				<col />
			</colgroup>
			<tbody>
				{listFacts(project, workspaces).map((fact) => (
					<tr key={fact.key} data-fact={fact.key}>
						<th scope="row">{fact.label}</th>
						<td title={fact.title} className={fact.isDim ? 'c-dim' : undefined}>
							{fact.value}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	</div>
);

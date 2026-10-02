// A project on this machine: what crew recorded (install, dev servers, environment), its check, the
// .env values crew could fill in, and its removal. AddProject.tsx is the form that records a new one.
import { useState } from 'react';
import type { SetupCommand } from '../../crew/commands.js';
import { isOk, useCrew, useCrewAction } from './api.js';
import { CommandLine } from './CommandLine.js';
import {
	Confirm,
	FailBlock,
	PageHead,
	ResultLine,
	type SetupContext,
	formatAgo,
} from './common.js';
import { describeBindingSource, readProposals } from './environment.js';
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
	const scan = useCrew<unknown>(ctx.machine, { type: 'add_binding_scan', project: name });
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
	const proposals = readProposals(scan.data);
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

	const add = async (command: SetupCommand) => {
		const reply = await action.run(command);

		if (isOk(reply)) {
			scan.refresh();
			projects.refresh();
		}
	};

	const isSetUp = Boolean(project?.dev_servers?.length);

	return (
		<section className="page" aria-label={`Project ${name}`}>
			<PageHead
				title={name}
				lead={
					failure ? (
						<>
							<span className="c-crit">Check failed</span> at {failure.stage}.
						</>
					) : isSetUp && checked.state === 'passed' ? (
						<>
							<span className="c-good">Ready.</span> Its check passed{' '}
							{formatAgo(checked.at ?? undefined)}.{' '}
							{project?.path ? `In ${project.path} on ${ctx.machineTitle}.` : ''}
						</>
					) : isSetUp ? (
						<>
							Set up, not checked yet: <b>{checkAction}</b> proves it reproduces from nothing.{' '}
							{project?.path ? `In ${project.path}.` : ''}
						</>
					) : (
						<>Not set up yet: no dev servers recorded. Its sessions work on the code meanwhile.</>
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
				<dl className="facts">
					<dt>Install</dt>
					<dd>
						{project.setup ? (
							<code>{project.setup}</code>
						) : (
							<span className="c-dim">detected from the lockfile</span>
						)}
					</dd>
					{project.env_cmd && (
						<>
							<dt>Env command</dt>
							<dd>
								<code>{project.env_cmd}</code>
							</dd>
						</>
					)}
					<dt>Dev servers</dt>
					<dd>
						{project.dev_servers?.length ? (
							<span className="envlist">
								{project.dev_servers.map((server) => (
									<span key={server.name}>
										{server.name} <code>{server.command}</code>
										{server.port ? ` :${server.port}` : ' · no port'}
										{server.dir ? <span className="m"> in {server.dir}</span> : null}
									</span>
								))}
							</span>
						) : (
							<span className="c-dim">none yet</span>
						)}
					</dd>
					<dt>Environment</dt>
					<dd className="envlist">
						{project.bindings?.length ? (
							project.bindings.map((binding) => (
								<span key={`${binding.var} ${binding.server ?? ''}`}>
									<code>{binding.var}</code> ← {describeBindingSource(binding.value)}
									{binding.server ? <span className="m"> · {binding.server} only</span> : null}
								</span>
							))
						) : (
							<span className="c-dim">nothing set by crew</span>
						)}
					</dd>
					<dt>Workspaces</dt>
					<dd>
						{memberOf.length ? (
							memberOf.map((workspace) => workspace.name).join(', ')
						) : (
							<span className="c-dim">none</span>
						)}
					</dd>
					<dt>Source</dt>
					<dd>{project.remote || <span className="c-dim">no git remote</span>}</dd>
				</dl>
			)}
			{proposals.length > 0 && (
				<>
					<div className="label">Found in .env: localhost addresses crew can fill in</div>
					<div className="box">
						{proposals.map((proposal) => (
							<div key={proposal.var} className="box-row">
								<span className="dot ring" />
								<span className="sub">
									<b>
										<code>{proposal.var}</code>
									</b>
									<span className="m">{proposal.note}</span>
								</span>
								{proposal.value ? (
									<button
										type="button"
										className="btn sm"
										onClick={() =>
											void add({
												type: 'add_binding',
												project: name,
												var: proposal.var,
												value: proposal.value ?? '',
											})
										}
									>
										Add
									</button>
								) : (
									<button
										type="button"
										className="btn sm"
										onClick={() => ctx.go({ page: 'project-edit', name })}
									>
										Choose…
									</button>
								)}
							</div>
						))}
					</div>
					<div className="row-actions">
						<button
							type="button"
							className="btn sm"
							disabled={action.isBusy}
							onClick={() => void add({ type: 'add_binding_scan_apply', project: name })}
						>
							Add all
						</button>
						<CommandLine commands={[{ type: 'add_binding_scan_apply', project: name }]} />
					</div>
				</>
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

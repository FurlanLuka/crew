// A machine's board: the Setup with Claude card, the problems strip, then one table — every project
// (install, dev servers, workspaces, state) or every workspace (projects, worktrees as pills).
import { type FormEvent, useEffect, useState } from 'react';
import { LOCAL_MACHINE } from '../../shared/machine-ref.js';
import type { BoardTab } from '../router.js';
import { describeRefusal, useCrew } from './api.js';
import type { SetupContext } from './common.js';
import {
	type Problem,
	deriveFirstRun,
	deriveProjectState,
	describeIssue,
	listProblems,
	listWorkspacesOf,
	readCheck,
	readCheckFailure,
} from './derive.js';
import { isSetupBusy, setupRefFor } from './SetupShell.js';
import type { CrewCheckStatus, CrewProject, CrewWorkspace, CrewWorktree } from './types.js';
import { Welcome } from './Welcome.js';
import { countOf } from '../count.js';

interface BoardProps {
	ctx: SetupContext;
	tab: BoardTab;
}

const BOARD_POLL_MS = 5000;

export const ClaudeCard = ({ ctx }: { ctx: SetupContext }) => {
	const [text, setText] = useState('');
	const ref = setupRefFor(ctx.machine);
	const session = ctx.state.sessions[ref];
	const isBusy = isSetupBusy(ctx.state, ref);
	const hasAsk = ctx.state.asks.some((ask) => ask.ref === ref);

	const submit = (event: FormEvent) => {
		event.preventDefault();

		if (text.trim()) {
			ctx.askClaude(text.trim());
		}
	};

	if (isBusy) {
		return (
			<div className="claude-card">
				<div className="cc-head">
					<span className={`dot ${hasAsk ? 'ask' : 'run'}`} />
					<b>Setup with Claude</b>
					<span className="m">{hasAsk ? 'waiting on you' : 'working'}</span>
					<button type="button" className="btn sm primary" onClick={() => ctx.go({ page: 'chat' })}>
						Open
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="claude-card">
			<div className="cc-head">
				<span className={`dot ${session ? 'ok' : 'ring'}`} />
				<b>Setup with Claude</b>
				{!session && <span className="m">starts when you ask</span>}
				<button type="button" className="btn sm ghost" onClick={() => ctx.go({ page: 'chat' })}>
					Open
				</button>
			</div>
			<form className="cc-input" onSubmit={submit}>
				<input
					type="text"
					placeholder="Ask setup anything: add a project, fix a server, check this machine…"
					aria-label="Ask setup"
					autoComplete="off"
					value={text}
					onChange={(event) => setText(event.target.value)}
				/>
				<button type="submit" className="btn sm primary">
					Ask
				</button>
			</form>
		</div>
	);
};

export const ProblemsStrip = ({ ctx, problems }: { ctx: SetupContext; problems: Problem[] }) => {
	if (problems.length === 0) {
		return null;
	}

	return (
		<div className="problems">
			{problems.map((problem) => (
				<div key={problem.key} className={`problem ${problem.isQuiet ? 'quiet' : ''}`}>
					<span className={`dot ${problem.isQuiet ? 'ring' : 'ask'}`} />
					<b>{problem.name}</b>
					<span>{problem.what}</span>
					<span className="problem-actions">
						{problem.fix && (
							<button
								type="button"
								className="btn sm"
								onClick={() => problem.fix && ctx.go(problem.fix)}
							>
								{problem.isQuiet ? 'Set up' : 'Fix'}
							</button>
						)}
						<button type="button" className="btn sm" onClick={() => ctx.askClaude(problem.ask)}>
							{problem.isQuiet ? 'Set up with Claude' : 'Fix with Claude'}
						</button>
					</span>
				</div>
			))}
		</div>
	);
};

const describeServers = (project: CrewProject): string =>
	project.dev_servers?.length
		? project.dev_servers
				.map((server) => `${server.name}${server.port ? ` :${server.port}` : ''}`)
				.join(' · ')
		: '—';

const describeLead = (
	projects: CrewProject[],
	workspaces: CrewWorkspace[],
	problems: Problem[],
): string => {
	const needs = problems.filter((problem) => !problem.isQuiet).length;
	const counts = `${countOf(projects.length, 'project')} in ${countOf(workspaces.length, 'workspace')}.`;

	return needs === 0
		? `${counts} Nothing needs you.`
		: `${counts} ${needs === 1 ? 'One thing needs' : `${needs} things need`} you.`;
};

// A set-up project is ready once crew's check passed; until then it offers the check.
const CheckCell = ({ ctx, project }: { ctx: SetupContext; project: string }) => {
	const check = useCrew<CrewCheckStatus>(ctx.machine, { type: 'check_status', project });
	const { state, failure } = readCheck(check.data, project, []);

	if (state === 'passed') {
		return <span className="chip ok">ready</span>;
	}

	if (state === 'running') {
		return <span className="chip run">checking</span>;
	}

	if (state === 'failed') {
		return (
			<button
				type="button"
				className="cell-fail"
				onClick={() => ctx.go({ page: 'project', name: project })}
			>
				<span className="chip ask">check failed</span>
				<span className="m">{failure?.stage}</span>
			</button>
		);
	}

	return (
		<span className="row-actions center">
			<span className="chip">{check.data ? 'not checked' : ''}</span>
			{check.data && (
				<button
					type="button"
					className="btn sm ghost"
					onClick={() => ctx.go({ page: 'check', name: project })}
				>
					Check
				</button>
			)}
		</span>
	);
};

export const Board = ({ ctx, tab }: BoardProps) => {
	const projects = useCrew<CrewProject[]>(
		ctx.machine,
		{ type: 'ls_projects' },
		{ pollMs: BOARD_POLL_MS },
	);
	const worktrees = useCrew<CrewWorktree[]>(
		ctx.machine,
		{ type: 'ls_worktrees' },
		{ pollMs: BOARD_POLL_MS },
	);
	const workspaces = useCrew<CrewWorkspace[]>(
		ctx.machine,
		{ type: 'ls_workspaces' },
		{ pollMs: BOARD_POLL_MS },
	);
	const stage = deriveFirstRun(projects.data, worktrees.data);
	// The empty board is the onboarding, on this Mac. Decided once per visit: the onboarding makes a
	// worktree, and must not be swapped for the board under the developer while it does.
	const [isWelcome, setIsWelcome] = useState<boolean | null>(null);

	useEffect(() => {
		if (isWelcome === null && projects.data && worktrees.data) {
			setIsWelcome(ctx.machine === LOCAL_MACHINE && stage !== 'ready');
		}
	}, [isWelcome, projects.data, worktrees.data, ctx.machine, stage]);

	if (isWelcome) {
		return <Welcome ctx={ctx} onDone={() => setIsWelcome(false)} />;
	}

	const projectRows = projects.data ?? [];
	const worktreeRows = worktrees.data ?? [];
	const workspaceRows = workspaces.data ?? [];
	const problems = listProblems(projectRows, worktreeRows);
	const isProjects = tab === 'projects';
	const failure = projects.reply && projects.reply.code !== 0 ? projects.reply : null;

	return (
		<section className="page" aria-label="Board">
			<div className="head-row">
				<div className="head-text">
					<h1>{ctx.machineTitle}</h1>
					<p className="lead">
						{projects.data ? describeLead(projectRows, workspaceRows, problems) : 'Reading crew…'}
					</p>
				</div>
			</div>
			<div className="toolbar">
				<div className="seg" role="tablist">
					<button
						type="button"
						role="tab"
						aria-selected={isProjects}
						onClick={() => ctx.go({ page: 'board', tab: 'projects' }, { replace: true })}
					>
						Projects
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={!isProjects}
						onClick={() => ctx.go({ page: 'board', tab: 'workspaces' }, { replace: true })}
					>
						Workspaces
					</button>
				</div>
				<button
					type="button"
					className="btn primary board-add"
					onClick={() => ctx.go(isProjects ? { page: 'project-new' } : { page: 'workspace-new' })}
				>
					{isProjects ? 'Add project' : 'New workspace'}
				</button>
				<span className="m status">
					{isProjects
						? `${countOf(projectRows.length, 'project')} on ${ctx.machineTitle}`
						: `${countOf(workspaceRows.length, 'workspace')} on ${ctx.machineTitle}`}
				</span>
			</div>
			<ClaudeCard ctx={ctx} />
			{failure && (
				<p className="result-line bad" role="alert">
					! {describeRefusal(failure)}
				</p>
			)}
			<ProblemsStrip ctx={ctx} problems={problems} />
			{isProjects ? (
				<div className="matrix-wrap">
					<table className="matrix">
						<thead>
							<tr>
								<th>Project</th>
								<th>Install</th>
								<th>Dev servers</th>
								<th>Workspaces</th>
								<th className="mh">State</th>
							</tr>
						</thead>
						<tbody>
							{projectRows.map((project) => {
								const state = deriveProjectState(project, worktreeRows);
								const check = readCheckFailure(project.name, worktreeRows);
								const memberOf = listWorkspacesOf(workspaceRows, project.name).map(
									(workspace) => workspace.name,
								);

								return (
									<tr key={project.name} data-project={project.name}>
										<td>
											<button
												type="button"
												className="rowname"
												onClick={() => ctx.go({ page: 'project', name: project.name })}
											>
												<b>{project.name}</b>
											</button>
										</td>
										<td>
											<code className="cellcode">{project.setup || '—'}</code>
										</td>
										<td className="m">{describeServers(project)}</td>
										<td className="m">{memberOf.length ? memberOf.join(', ') : '—'}</td>
										<td className="cell">
											{state === 'ready' ? (
												<CheckCell ctx={ctx} project={project.name} />
											) : state === 'failed' ? (
												<button
													type="button"
													className="cell-fail"
													onClick={() => ctx.go({ page: 'project', name: project.name })}
												>
													<span className="chip ask">check failed</span>
													<span className="m">{check?.stage}</span>
												</button>
											) : (
												<span className="row-actions center">
													<button
														type="button"
														className="btn sm"
														onClick={() => ctx.go({ page: 'project-edit', name: project.name })}
													>
														Set up
													</button>
													<button
														type="button"
														className="btn sm ghost"
														onClick={() => ctx.askClaude(`Set up ${project.name}.`)}
													>
														Ask Claude
													</button>
												</span>
											)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			) : (
				<div className="matrix-wrap">
					<table className="matrix">
						<thead>
							<tr>
								<th>Workspace</th>
								<th>Projects</th>
								<th>Worktrees</th>
							</tr>
						</thead>
						<tbody>
							{workspaceRows.map((workspace) => (
								<tr key={workspace.name} data-workspace={workspace.name}>
									<td>
										<button
											type="button"
											className="rowname"
											onClick={() => ctx.go({ page: 'workspace', name: workspace.name })}
										>
											<b>{workspace.name}</b>
										</button>
									</td>
									<td className="m">
										{workspace.projects?.length
											? workspace.projects.map((member) => member.name).join(' · ')
											: countOf(workspace.project_count, 'project')}
									</td>
									<td>
										<span className="srv">
											{workspace.worktrees.map((name) => {
												const ref = `${workspace.name}/${name}`;
												const row = worktreeRows.find((worktree) => worktree.ref === ref);
												const issue = row?.issues?.[0];
												const cls = issue
													? 'down'
													: row?.installing
														? 'wait'
														: row?.dev_running
															? 'up'
															: '';

												return (
													<button
														key={name}
														type="button"
														className={cls}
														title={issue ? describeIssue(issue) : undefined}
														onClick={() => ctx.go({ page: 'worktree', ref })}
													>
														{name}
														{issue
															? ` · ${issue.server ?? issue.project} ${issue.stage === 'smoke' ? 'died' : 'failed'}`
															: row?.installing
																? ' · installing'
																: ''}
													</button>
												);
											})}
											<button
												type="button"
												onClick={() => ctx.go({ page: 'worktree-new', workspace: workspace.name })}
											>
												+ new
											</button>
										</span>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
};

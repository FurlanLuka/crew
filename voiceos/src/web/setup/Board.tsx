// A machine's board: the Setup with Claude card, the problems strip, then one table — every project
// (install, dev servers, workspaces, state) or every workspace (projects, worktrees as pills).
import { type FormEvent, useEffect, useState } from 'react';
import { LOCAL_MACHINE } from '../../shared/machine-ref.js';
import type { BoardTab } from '../router.js';
import { describeRefusal, useCrew } from './api.js';
import { type SetupContext, followRow } from './common.js';
import {
	type Problem,
	deriveFirstRun,
	describeIssue,
	describeServer,
	listProblems,
	listWorkspacesOf,
	readCheck,
	summarizeList,
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
				<div key={problem.key} className="problem">
					<span className="dot ask" />
					<b>{problem.name}</b>
					<span>{problem.what}</span>
					<span className="problem-actions">
						<button type="button" className="btn sm" onClick={() => ctx.go(problem.fix)}>
							Fix
						</button>
						<button type="button" className="btn sm" onClick={() => ctx.askClaude(problem.ask)}>
							Fix with Claude
						</button>
					</span>
				</div>
			))}
		</div>
	);
};

// Shown before "+N" in a cell: what fits one line beside the other columns.
const SERVERS_SHOWN = 2;
const WORKSPACES_SHOWN = 1;
const MEMBERS_SHOWN = 3;
const WORKTREES_SHOWN = 3;

const describeLead = (
	projects: CrewProject[],
	workspaces: CrewWorkspace[],
	problems: Problem[],
): string => {
	const needs = problems.length;
	const counts = `${countOf(projects.length, 'project')} in ${countOf(workspaces.length, 'workspace')}.`;

	return needs === 0
		? `${counts} Nothing needs you.`
		: `${counts} ${needs === 1 ? 'One thing needs' : `${needs} things need`} you.`;
};

interface CheckCellProps {
	ctx: SetupContext;
	project: string;
	worktrees: CrewWorktree[];
}

// One element, so the row stays one line: ready, checking, a failed check (its stage in the
// title), or the button that runs the first check.
const CheckCell = ({ ctx, project, worktrees }: CheckCellProps) => {
	const check = useCrew<CrewCheckStatus>(ctx.machine, {
		type: 'check_status',
		project,
	});
	const { state, failure } = readCheck(check.data, project, worktrees);

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
				title={failure ? `failed at ${failure.stage}` : undefined}
				onClick={() => ctx.go({ page: 'project', name: project })}
			>
				<span className="chip ask">check failed</span>
			</button>
		);
	}

	return check.data ? (
		<button
			type="button"
			className="btn sm ghost"
			title="Not checked yet: prove it reproduces from nothing"
			onClick={() => ctx.go({ page: 'check', name: project })}
		>
			Check
		</button>
	) : null;
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
	const problems = listProblems(worktreeRows);
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
					<table className="matrix projects">
						<colgroup>
							<col className="c-name" />
							<col className="c-install" />
							<col className="c-servers" />
							<col className="c-workspaces" />
							<col className="c-state" />
						</colgroup>
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
								const servers = (project.dev_servers ?? []).map(describeServer);
								const memberOf = listWorkspacesOf(workspaceRows, project.name).map(
									(workspace) => workspace.name,
								);

								return (
									<tr
										key={project.name}
										className="row-link"
										data-project={project.name}
										onClick={followRow(() => ctx.go({ page: 'project', name: project.name }))}
									>
										<td>
											<button
												type="button"
												className="rowname"
												title={project.name}
												onClick={() => ctx.go({ page: 'project', name: project.name })}
											>
												<b>{project.name}</b>
											</button>
										</td>
										<td title={project.setup || undefined}>
											<code className="cellcode">{project.setup || '—'}</code>
										</td>
										<td className="m" title={servers.join(' · ') || undefined}>
											{servers.length ? summarizeList(servers, SERVERS_SHOWN) : '—'}
										</td>
										<td className="m" title={memberOf.join(', ') || undefined}>
											{memberOf.length ? summarizeList(memberOf, WORKSPACES_SHOWN) : '—'}
										</td>
										<td className="cell">
											<CheckCell ctx={ctx} project={project.name} worktrees={worktreeRows} />
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			) : (
				<div className="matrix-wrap">
					<table className="matrix workspaces">
						<colgroup>
							<col className="c-name" />
							<col className="c-members" />
							<col className="c-worktrees" />
						</colgroup>
						<thead>
							<tr>
								<th>Workspace</th>
								<th>Projects</th>
								<th>Worktrees</th>
							</tr>
						</thead>
						<tbody>
							{workspaceRows.map((workspace) => {
								const members = (workspace.projects ?? []).map((member) => member.name);
								const hidden = workspace.worktrees.length - WORKTREES_SHOWN;

								return (
									<tr
										key={workspace.name}
										className="row-link"
										data-workspace={workspace.name}
										onClick={followRow(() => ctx.go({ page: 'workspace', name: workspace.name }))}
									>
										<td>
											<button
												type="button"
												className="rowname"
												title={workspace.name}
												onClick={() => ctx.go({ page: 'workspace', name: workspace.name })}
											>
												<b>{workspace.name}</b>
											</button>
										</td>
										<td className="m" title={members.join(' · ') || undefined}>
											{members.length
												? summarizeList(members, MEMBERS_SHOWN)
												: countOf(workspace.project_count, 'project')}
										</td>
										<td>
											<span className="srv">
												{workspace.worktrees.slice(0, WORKTREES_SHOWN).map((name) => {
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
												{hidden > 0 && (
													<button
														type="button"
														title={workspace.worktrees.slice(WORKTREES_SHOWN).join(', ')}
														onClick={() =>
															ctx.go({
																page: 'workspace',
																name: workspace.name,
															})
														}
													>
														+{hidden}
													</button>
												)}
												<button
													type="button"
													onClick={() =>
														ctx.go({
															page: 'worktree-new',
															workspace: workspace.name,
														})
													}
												>
													+ new
												</button>
											</span>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
};

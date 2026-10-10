// A worktree: its name with rename and duplicate beside it, Open in Voice OS, a recorded failure with
// its ways out, its servers with their actions (start, stop, restart, verify, logs), Claude Desktop
// (open it on this Mac, or the link that opens it over SSH from another computer), its Environment
// (values set for this worktree, what each server gets), and its removal. Rename and duplicate are
// their own small forms (WorktreeForms.tsx); what it reads is derived in worktree.ts.
import { useState } from 'react';
import type { SetupCommand } from '../../crew/commands.js';
import { LOCAL_MACHINE, refOn } from '../../shared/machine-ref.js';
import { isOk, useCrew, useCrewAction } from './api.js';
import {
	Confirm,
	FailBlock,
	PageHead,
	ResultLine,
	type SetupContext,
	describeSize,
} from './common.js';
import { describeIssue, describeStages } from './derive.js';
import type { ConfigShow } from './settings/settings.js';
import type {
	CrewDryRun,
	CrewMember,
	CrewProject,
	CrewRoute,
	CrewSmoke,
	CrewWorktree,
} from './types.js';
import {
	type ServerLine,
	describeIssueWhy,
	desktopFolder,
	desktopLink,
	listServerLines,
} from './worktree.js';
import { WorktreeEnvironment, WorktreeOverrides } from './WorktreeValues.js';

interface WorktreePageProps {
	ctx: SetupContext;
	worktreeRef: string;
}

const POLL_MS = 4000;

const SERVER_DOT: Record<ServerLine['state'], string> = {
	up: 'ok',
	died: 'ask',
	quiet: 'run',
	stopped: 'ring',
};

export const WorktreePage = ({ ctx, worktreeRef }: WorktreePageProps) => {
	const [workspace = ''] = worktreeRef.split('/');
	const worktrees = useCrew<CrewWorktree[]>(
		ctx.machine,
		{ type: 'ls_worktrees', workspace, size: true },
		{ pollMs: POLL_MS },
	);
	const members = useCrew<CrewMember[]>(ctx.machine, { type: 'show', ref: worktreeRef });
	const projects = useCrew<CrewProject[]>(ctx.machine, { type: 'ls_projects' });
	const row = worktrees.data?.find((candidate) => candidate.ref === worktreeRef);
	const checks = useCrew<CrewSmoke[]>(
		ctx.machine,
		row?.dev_running ? { type: 'dev_check', ref: worktreeRef } : null,
		{ pollMs: POLL_MS },
	);
	const routes = useCrew<CrewRoute[]>(
		ctx.machine,
		row?.dev_running ? { type: 'dev_status', ref: worktreeRef } : null,
	);
	const action = useCrewAction(ctx.machine);
	// Only this Mac opens Desktop itself: on another machine crew would open it on a headless box.
	const isLocal = ctx.machine === LOCAL_MACHINE;
	const config = useCrew<ConfigShow>(ctx.machine, isLocal ? { type: 'config_show' } : null);
	const desktop = useCrewAction(ctx.machine);
	const [isRemoving, setIsRemoving] = useState(false);
	// The workspace's last worktree: removing it is removing the workspace (crew says which).
	const removal = useCrew<CrewDryRun>(
		ctx.machine,
		isRemoving ? { type: 'rm_worktree_dry_run', ref: worktreeRef } : null,
	);
	const isLast = removal.data?.last === true;
	const memberRows = members.data ?? [];
	// Bumped when a value set for this worktree changes: what each server gets follows.
	const [valuesChanged, setValuesChanged] = useState(0);
	const servers = listServerLines({
		members: memberRows,
		projects: projects.data ?? [],
		checks: checks.data ?? [],
		routes: routes.data ?? [],
		worktreeRef,
	});
	const issue = row?.issues?.[0];
	const sessionRef = refOn(ctx.machine, worktreeRef);
	const sshHost = isLocal
		? (config.data?.ssh_host ?? '')
		: (ctx.state.machines[ctx.machine]?.host ?? '');
	const link =
		row && members.data
			? desktopLink({ sshHost, folder: desktopFolder(members.data, row.path) })
			: null;
	// No hint before crew has answered: an unread ssh_host is not an unset one.
	const needsHost = isLocal && config.data !== null && !sshHost;

	const run = async (command: SetupCommand) => {
		const reply = await action.run(command);

		worktrees.refresh();
		checks.refresh();
		routes.refresh();

		return reply;
	};

	if (worktrees.data && !row) {
		return (
			<section className="page">
				<PageHead title={worktreeRef} lead={`No worktree ${worktreeRef} on ${ctx.machineTitle}.`} />
			</section>
		);
	}

	const isRunning = Boolean(row?.dev_running);

	return (
		<section className="page" aria-label={`Worktree ${worktreeRef}`}>
			<PageHead
				title={worktreeRef}
				lead={[
					ctx.machineTitle,
					`branch crew/${worktreeRef}/*`,
					row?.size_bytes ? `${describeSize(row.size_bytes)} on disk` : '',
				]
					.filter(Boolean)
					.join(' · ')}
				titleActions={
					<>
						<button
							type="button"
							className="icon-btn"
							title="Rename"
							aria-label="Rename"
							onClick={() => ctx.go({ page: 'rename', ref: worktreeRef })}
						>
							<svg viewBox="0 0 16 16" aria-hidden="true">
								<path d="M11.5 2.5l2 2L6 12H4v-2z" />
							</svg>
						</button>
						<button
							type="button"
							className="icon-btn"
							title="Duplicate"
							aria-label="Duplicate"
							onClick={() => ctx.go({ page: 'duplicate', ref: worktreeRef })}
						>
							<svg viewBox="0 0 16 16" aria-hidden="true">
								<rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
								<path d="M10.5 3.5v-1h-8v8h1" />
							</svg>
						</button>
					</>
				}
			>
				<button type="button" className="btn" onClick={() => ctx.openVoice(sessionRef)}>
					Open in Voice OS
				</button>
			</PageHead>
			{issue && (
				<FailBlock
					title={describeIssue(issue).split(' · ')[0] ?? 'Something failed'}
					when={row?.health}
					steps={describeStages(issue.stage)}
					log={issue.detail}
					why={describeIssueWhy(issue)}
				>
					{issue.stage !== 'smoke' && (
						<button
							type="button"
							className="btn primary"
							disabled={action.isBusy}
							onClick={async () => {
								if (
									isOk(
										await run({ type: 'setup_rerun', ref: worktreeRef, projects: [issue.project] }),
									)
								) {
									ctx.go({ page: 'progress', ref: worktreeRef });
								}
							}}
						>
							{issue.stage === 'install' ? 'Install again' : 'Retry'}
						</button>
					)}
					<button
						type="button"
						className={`btn ${issue.stage === 'smoke' ? 'primary' : ''}`}
						onClick={() => ctx.askClaude(`In ${worktreeRef}: ${describeIssue(issue)}. Fix it.`)}
					>
						Fix with Claude
					</button>
					<button
						type="button"
						className="btn ghost"
						onClick={() => ctx.go({ page: 'logs', ref: worktreeRef })}
					>
						Full log
					</button>
				</FailBlock>
			)}
			<section className="section" aria-label="Dev servers">
				<div className="section-head">
					<div className="label">Dev servers</div>
					<div className="row-actions">
						{row?.installing && (
							<button
								type="button"
								className="btn sm"
								onClick={() => ctx.go({ page: 'progress', ref: worktreeRef })}
							>
								Installing… follow it
							</button>
						)}
						<button
							type="button"
							className="btn sm"
							disabled={action.isBusy || row?.installing}
							onClick={() =>
								void run(
									isRunning
										? { type: 'dev_stop', ref: worktreeRef }
										: { type: 'dev_start', ref: worktreeRef },
								)
							}
						>
							{isRunning ? 'Stop servers' : 'Start servers'}
						</button>
						{isRunning && (
							<button
								type="button"
								className="btn sm"
								disabled={action.isBusy}
								onClick={() => void run({ type: 'dev_restart', ref: worktreeRef })}
							>
								Restart
							</button>
						)}
						<button
							type="button"
							className="btn sm"
							disabled={action.isBusy || row?.installing}
							onClick={async () => {
								if (isOk(await run({ type: 'verify', ref: worktreeRef }))) {
									ctx.go({ page: 'progress', ref: worktreeRef });
								}
							}}
						>
							Verify
						</button>
						<button
							type="button"
							className="btn sm ghost"
							onClick={() => ctx.go({ page: 'logs', ref: worktreeRef })}
						>
							Logs
						</button>
					</div>
				</div>
				<div className="box">
					{servers.length === 0 && (
						<div className="box-row">
							<span className="dot idle" />
							<span className="sub">
								<span className="m">No dev servers</span>
							</span>
						</div>
					)}
					{servers.map((server) => (
						<div
							key={`${server.project} ${server.name}`}
							className="box-row srv-full one-line"
							data-server={server.name}
							data-state={server.state}
							title={`${server.name} · ${server.project} · ${server.command}`}
						>
							<span className={`dot ${SERVER_DOT[server.state]}`} />
							<span className="sub">
								<b>{server.name}</b>
								<span className="m">
									{server.project} · {server.command}
								</span>
							</span>
							{server.state === 'died' ? (
								<span className="chip ask">died{server.port ? ` · :${server.port}` : ''}</span>
							) : server.url ? (
								<span className="links">
									<a href={server.url} target="_blank" rel="noopener noreferrer">
										{server.url.replace(/^https?:\/\//, '')} ↗
									</a>
								</span>
							) : (
								<span className="chip">
									{server.state === 'quiet'
										? 'not listening yet'
										: server.state === 'stopped'
											? 'stopped'
											: 'running, no port'}
								</span>
							)}
							<span className="row-actions">
								<button
									type="button"
									className="btn sm ghost"
									onClick={() => ctx.go({ page: 'logs', ref: worktreeRef })}
								>
									Logs
								</button>
							</span>
						</div>
					))}
				</div>
			</section>
			<ResultLine reply={action.last} />
			<section className="section" aria-label="Claude Desktop">
				<div className="section-head">
					<div className="label">Claude Desktop</div>
					{isLocal && config.data?.desktop_available && (
						<div className="row-actions">
							<button
								type="button"
								className="btn sm"
								disabled={desktop.isBusy}
								onClick={() => void desktop.run({ type: 'claude_desktop', ref: worktreeRef })}
							>
								Open on this Mac
							</button>
						</div>
					)}
				</div>
				<dl className="facts">
					<dt>Over SSH</dt>
					<dd className="desktop-ssh">
						{link && (
							<>
								<a href={link}>{link}</a>
								<small className="m">
									{isLocal
										? 'From another computer: open this link there; Desktop connects to this machine over SSH.'
										: `Open it on your computer; Desktop connects to ${ctx.machineTitle} over SSH.`}
								</small>
							</>
						)}
						{needsHost && (
							<>
								<code>crew config set ssh_host &lt;host&gt;</code>
								<small className="m">Set this machine's SSH host and the link shows here.</small>
							</>
						)}
					</dd>
				</dl>
				<ResultLine reply={desktop.last} />
			</section>
			<WorktreeOverrides
				ctx={ctx}
				worktreeRef={worktreeRef}
				members={memberRows}
				projects={projects.data ?? []}
				onChanged={() => setValuesChanged((count) => count + 1)}
			/>
			<WorktreeEnvironment
				ctx={ctx}
				worktreeRef={worktreeRef}
				members={memberRows}
				refreshKey={valuesChanged}
			/>
			<dl className="facts">
				<dt>On disk</dt>
				<dd>{[describeSize(row?.size_bytes), row?.path].filter(Boolean).join(' · ')}</dd>
				<dt>Projects</dt>
				<dd>{memberRows.map((member) => `${member.name} (${member.mode})`).join(', ') || '—'}</dd>
			</dl>
			{isRemoving ? (
				<Confirm
					key={isLast ? 'last' : 'one'}
					title={
						isLast
							? `Remove ${worktreeRef} and the ${workspace} workspace?`
							: `Remove ${worktreeRef}?`
					}
					why={
						<p className="fail-why">
							{isLast ? `It is ${workspace}'s last worktree, so the workspace goes with it. ` : ''}
							Its checkouts go to the trash and crew's branches are deleted; commits not on the base
							stay in git's reflog. Its servers stop first.
						</p>
					}
					command={
						isLast
							? { type: 'rm_workspace', workspace, confirm: true }
							: { type: 'rm_worktree', ref: worktreeRef, confirm: true }
					}
					cost={removal}
					machine={ctx.machine}
					actionLabel="Remove worktree"
					run={action.run}
					onCancel={() => setIsRemoving(false)}
					onDone={() =>
						ctx.go(
							isLast
								? { page: 'board', tab: 'workspaces' }
								: { page: 'workspace', name: workspace },
						)
					}
				/>
			) : (
				<div className="row-actions">
					<button type="button" className="btn danger" onClick={() => setIsRemoving(true)}>
						Remove worktree
					</button>
				</div>
			)}
		</section>
	);
};

// A workspace: its worktrees, each with its state, size and servers. Its projects are in its
// settings (WorkspaceForm.tsx), with the workspace's removal.
import type { SetupCommand } from '../../crew/commands.js';
import { refOn } from '../../shared/machine-ref.js';
import { isOk, useCrew, useCrewAction } from './api.js';
import { LoadingRow, PageHead, ResultLine, type SetupContext, describeSize } from './common.js';
import type { CrewProject, CrewWorkspace, CrewWorktree } from './types.js';
import { type PillState, type WorktreeCard, listWorktreeCards } from './workspace.js';
import { countOf } from '../count.js';

const POLL_MS = 4000;

const CARD_DOT: Record<WorktreeCard['state'], string> = {
	issue: 'ask',
	installing: 'run',
	running: 'ok',
	stopped: 'ring',
};

const PILL_DOT: Record<PillState, string> = {
	up: 'ok',
	died: 'ask',
	wait: 'run',
	stopped: 'ring',
};

interface WorkspacePageProps {
	ctx: SetupContext;
	name: string;
}

export const WorkspacePage = ({ ctx, name }: WorkspacePageProps) => {
	const workspaces = useCrew<CrewWorkspace[]>(ctx.machine, { type: 'ls_workspaces' });
	// The list is read fast and often; sizes walk every checkout, so they come once, later.
	const worktrees = useCrew<CrewWorktree[]>(
		ctx.machine,
		{ type: 'ls_worktrees', workspace: name },
		{ pollMs: POLL_MS },
	);
	const sizes = useCrew<CrewWorktree[]>(ctx.machine, {
		type: 'ls_worktrees',
		workspace: name,
		size: true,
	});
	const projects = useCrew<CrewProject[]>(ctx.machine, { type: 'ls_projects' });
	const action = useCrewAction(ctx.machine);
	const workspace = workspaces.data?.find((row) => row.name === name);
	const members = (workspace?.projects ?? []).map((member) => member.name);
	const cards = listWorktreeCards({
		workspace: name,
		rows: worktrees.data ?? [],
		sizes: sizes.data ?? [],
		members,
		projects: projects.data ?? [],
	});

	const run = async (command: SetupCommand) => {
		await action.run(command);
		worktrees.refresh();
	};

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
						: members.length
							? `${members.join(', ')}. Each worktree has every one of them, on its own branch and ports.`
							: ' '
				}
				titleActions={
					<button
						type="button"
						className="icon-btn"
						title="Workspace settings"
						aria-label="Workspace settings"
						onClick={() => ctx.go({ page: 'workspace-edit', name })}
					>
						<svg viewBox="0 0 16 16" aria-hidden="true">
							<circle cx="8" cy="8" r="2" />
							<path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
						</svg>
					</button>
				}
			>
				<button
					type="button"
					className="btn primary"
					onClick={() => ctx.go({ page: 'worktree-new', workspace: name })}
				>
					New worktree
				</button>
			</PageHead>
			<div className="label">
				Worktrees{' '}
				<span className="m label-note">
					{worktrees.data ? `${countOf(cards.length, 'worktree')} on ${ctx.machineTitle}` : ''}
				</span>
			</div>
			<div className="wt-cards">
				{worktrees.data === null && <LoadingRow text="Reading worktrees…" />}
				{worktrees.data && cards.length === 0 && (
					<div className="box">
						<div className="box-row">
							<span className="dot ring" />
							<span className="sub">
								<b>No worktrees yet</b>
								<span className="m">
									New worktree checks out every project on its own branch and ports.
								</span>
							</span>
						</div>
					</div>
				)}
				{cards.map((card) => (
					<div key={card.ref} className="wt-card" data-ref={card.ref} data-state={card.state}>
						<div className="wt-card-head">
							<span className={`dot ${CARD_DOT[card.state]}`} />
							<button
								type="button"
								className="rowname"
								onClick={() => ctx.go({ page: 'worktree', ref: card.ref })}
							>
								<b>{card.name}</b>
							</button>
							<span className="m wt-card-status">
								{[card.status, describeSize(card.sizeBytes)].filter(Boolean).join(' · ')}
							</span>
							{card.state === 'issue' && <span className="chip ask">needs you</span>}
							{card.state === 'stopped' && (
								<button
									type="button"
									className="btn sm"
									disabled={action.isBusy}
									onClick={() => void run({ type: 'dev_start', ref: card.ref })}
								>
									Start
								</button>
							)}
							<button
								type="button"
								className="btn sm"
								onClick={() => ctx.openVoice(refOn(ctx.machine, card.ref))}
							>
								Open in Voice OS
							</button>
						</div>
						{card.servers.length > 0 && (
							<div className="wt-pills">
								{card.servers.map((server) => (
									<span
										key={`${server.project} ${server.name}`}
										className="wt-pill"
										data-server={server.name}
										data-state={server.state}
									>
										<span className={`dot ${PILL_DOT[server.state]}`} />
										{server.name}
										{server.state === 'died' ? ' died' : ''}
									</span>
								))}
							</div>
						)}
					</div>
				))}
			</div>
			<ResultLine reply={action.last && !isOk(action.last) ? action.last : null} />
		</section>
	);
};

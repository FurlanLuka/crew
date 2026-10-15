// A worktree: its name with rename and duplicate beside it, Open in Voice OS, its servers card
// (ServersCard.tsx: actions, verify and installs followed in place, each server's log), its
// Environment card and its removal. Rename and duplicate are their own small forms
// (WorktreeForms.tsx).
import { useState } from 'react';
import { refOn } from '../../shared/machine-ref.js';
import { useCrew, useCrewAction } from './api.js';
import { Confirm, LoadingRow, PageHead, type SetupContext, describeSize } from './common.js';
import { ServersCard } from './ServersCard.js';
import type { CrewDryRun, CrewMember, CrewProject, CrewWorktree } from './types.js';
import { WorktreeEnvironment } from './WorktreeValues.js';

interface WorktreePageProps {
	ctx: SetupContext;
	worktreeRef: string;
}

const POLL_MS = 4000;

export const WorktreePage = ({ ctx, worktreeRef }: WorktreePageProps) => {
	const [workspace = ''] = worktreeRef.split('/');
	// The row is read fast and often; its size walks every checkout, so it comes once, later.
	const worktrees = useCrew<CrewWorktree[]>(
		ctx.machine,
		{ type: 'ls_worktrees', workspace },
		{ pollMs: POLL_MS },
	);
	const sizes = useCrew<CrewWorktree[]>(ctx.machine, {
		type: 'ls_worktrees',
		workspace,
		size: true,
	});
	const members = useCrew<CrewMember[]>(ctx.machine, { type: 'show', ref: worktreeRef });
	const projects = useCrew<CrewProject[]>(ctx.machine, { type: 'ls_projects' });
	const row = worktrees.data?.find((candidate) => candidate.ref === worktreeRef);
	const size = sizes.data?.find((candidate) => candidate.ref === worktreeRef)?.size_bytes;
	const action = useCrewAction(ctx.machine);
	const [isRemoving, setIsRemoving] = useState(false);
	// The workspace's last worktree: removing it is removing the workspace (crew says which).
	const removal = useCrew<CrewDryRun>(
		ctx.machine,
		isRemoving ? { type: 'rm_worktree_dry_run', ref: worktreeRef } : null,
	);
	const isLast = removal.data?.last === true;
	const memberRows = members.data ?? [];

	if (worktrees.data && !row) {
		return (
			<section className="page">
				<PageHead title={worktreeRef} lead={`No worktree ${worktreeRef} on ${ctx.machineTitle}.`} />
			</section>
		);
	}

	return (
		<section className="page" aria-label={`Worktree ${worktreeRef}`}>
			<PageHead
				title={worktreeRef}
				lead={[
					ctx.machineTitle,
					`branch crew/${worktreeRef}/*`,
					size ? `${describeSize(size)} on disk` : '',
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
				<button
					type="button"
					className="btn"
					onClick={() => ctx.openVoice(refOn(ctx.machine, worktreeRef))}
				>
					Open in Voice OS
				</button>
			</PageHead>
			<div className="label">Dev servers</div>
			{row ? (
				<ServersCard
					ctx={ctx}
					worktreeRef={worktreeRef}
					row={row}
					members={memberRows}
					projects={projects.data ?? []}
					onChanged={worktrees.refresh}
				/>
			) : (
				<LoadingRow text="Reading the worktree…" />
			)}
			<WorktreeEnvironment
				ctx={ctx}
				worktreeRef={worktreeRef}
				members={memberRows}
				projects={projects.data ?? []}
			/>
			<dl className="facts">
				<dt>On disk</dt>
				<dd>{[describeSize(size), row?.path].filter(Boolean).join(' · ')}</dd>
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

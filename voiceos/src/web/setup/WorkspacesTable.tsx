// The board's Workspaces tab: each workspace with its projects and its worktrees as chips, the state
// of each in its colour and what failed in its words.
import { type SetupContext, followRow } from './common.js';
import {
	describeIssue,
	describeWorktreePill,
	readWorktreeState,
	summarizeList,
	type WorktreeState,
} from './derive.js';
import type { CrewWorkspace, CrewWorktree } from './types.js';
import { countOf } from '../count.js';

// Shown before "+N" in a cell: what fits one line beside the other columns.
const MEMBERS_SHOWN = 3;
const WORKTREES_SHOWN = 3;

const PILL_CLASS: Record<WorktreeState, string> = {
	issue: 'down',
	installing: 'wait',
	running: 'up',
	stopped: '',
};

interface WorkspacesTableProps {
	ctx: SetupContext;
	workspaces: CrewWorkspace[];
	worktrees: CrewWorktree[];
}

export const WorkspacesTable = ({
	ctx,
	workspaces: workspaceRows,
	worktrees: worktreeRows,
}: WorkspacesTableProps) => (
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
										const cls = row ? PILL_CLASS[readWorktreeState(row)] : '';

										return (
											<button
												key={name}
												type="button"
												className={cls}
												title={issue ? describeIssue(issue) : undefined}
												onClick={() => ctx.go({ page: 'worktree', ref })}
											>
												{name}
												{row ? describeWorktreePill(row) : ''}
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
);

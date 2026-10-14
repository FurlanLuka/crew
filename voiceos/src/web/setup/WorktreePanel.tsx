// Beside the setup chat: the worktree Claude is on, its servers card live — what verify, a restart
// or a new dev server does shows here while Claude works.
import { useCrew } from './api.js';
import type { SetupContext } from './common.js';
import { ServersCard } from './ServersCard.js';
import type { CrewMember, CrewProject, CrewWorktree } from './types.js';

const POLL_MS = 3000;

interface WorktreePanelProps {
	ctx: SetupContext;
	worktreeRef: string;
	projects: CrewProject[];
	onClose: () => void;
}

export const WorktreePanel = ({ ctx, worktreeRef, projects, onClose }: WorktreePanelProps) => {
	const [workspace = ''] = worktreeRef.split('/');
	const worktrees = useCrew<CrewWorktree[]>(
		ctx.machine,
		{ type: 'ls_worktrees', workspace },
		{ pollMs: POLL_MS },
	);
	const members = useCrew<CrewMember[]>(ctx.machine, { type: 'show', ref: worktreeRef });
	const row = worktrees.data?.find((candidate) => candidate.ref === worktreeRef);

	return (
		<aside className="chat-panel" aria-label={`${worktreeRef} beside the chat`}>
			<div className="chat-panel-head">
				<b>{worktreeRef}</b>
				<button
					type="button"
					className="btn sm ghost"
					onClick={() => ctx.go({ page: 'worktree', ref: worktreeRef })}
				>
					Open worktree
				</button>
				<button type="button" className="x" aria-label="Close the panel" onClick={onClose}>
					×
				</button>
			</div>
			{row ? (
				<ServersCard
					key={worktreeRef}
					ctx={ctx}
					worktreeRef={worktreeRef}
					row={row}
					members={members.data ?? []}
					projects={projects}
					onChanged={worktrees.refresh}
				/>
			) : (
				<p className="m">{worktrees.data ? `No worktree ${worktreeRef} here.` : 'Reading…'}</p>
			)}
		</aside>
	);
};

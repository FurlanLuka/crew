// Moving to another machine: what an export carries, and the way to its two pages.
import type { SetupContext } from '../common.js';

export const MoveSection = ({ ctx }: { ctx: SetupContext }) => (
	<div className="cfg-sec">
		<div className="cfg-h">
			<span className="label">Move to another machine</span>
		</div>
		<p className="fail-why">
			An export holds projects (by their git remote) and which workspaces they're in. Worktrees,
			ports and worktree values stay here.
		</p>
		<div className="row-actions">
			<button type="button" className="btn" onClick={() => ctx.go({ page: 'export' })}>
				Export…
			</button>
			<button type="button" className="btn" onClick={() => ctx.go({ page: 'import' })}>
				Import…
			</button>
		</div>
	</div>
);

// A machine with no workspace yet, after the first run was skipped (or everything was removed):
// the three ways to start, here instead of the first run.
import type { SetupContext } from './common.js';

export const EmptyBoard = ({ ctx }: { ctx: SetupContext }) => (
	<div className="empty-board" aria-label="Nothing set up yet">
		<div className="empty-way">
			<b>New workspace</b>
			<span>Pick the projects that belong together. crew clones the ones it doesn't know yet.</span>
			<button
				type="button"
				className="btn primary sm"
				onClick={() => ctx.go({ page: 'workspace-new' })}
			>
				New workspace
			</button>
		</div>
		<div className="empty-way">
			<b>Import</b>
			<span>Everything from another machine's crew export.</span>
			<button type="button" className="btn sm" onClick={() => ctx.go({ page: 'import' })}>
				Import…
			</button>
		</div>
		<div className="empty-way">
			<b>Ask Claude</b>
			<span>"Set up store-front and store-api together." It reads the repos and records them.</span>
			<button type="button" className="btn sm" onClick={() => ctx.go({ page: 'chat' })}>
				Open the chat
			</button>
		</div>
	</div>
);

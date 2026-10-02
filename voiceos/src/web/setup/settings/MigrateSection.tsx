// Workspaces from before crew 2.0: shown only when crew migrate --dry-run lists one.
import { useState } from 'react';
import { useCrew, useCrewAction } from '../api.js';
import { Confirm, type SetupContext } from '../common.js';
import { countRows } from './settings.js';
import { countOf } from '../../count.js';

export const MigrateSection = ({ ctx }: { ctx: SetupContext }) => {
	const plan = useCrew<unknown>(ctx.machine, { type: 'migrate_dry_run' });
	const action = useCrewAction(ctx.machine);
	const [isConfirming, setIsConfirming] = useState(false);
	const count = countRows(plan.data);

	if (count === 0) {
		return null;
	}

	return (
		<div className="cfg-sec">
			<div className="cfg-h">
				<span className="label">From before crew 2.0</span>
			</div>
			<p className="fail-why">
				{countOf(count, 'workspace has', 'workspaces have')} the flat layout: no worktrees can be
				added until it moves.
			</p>
			{isConfirming ? (
				<Confirm
					title="Migrate to worktrees?"
					// Under --json the moves are the document and the plan text is crew's narration.
					why={<pre className="log">{plan.reply?.stderr ?? ''}</pre>}
					command={{ type: 'migrate', confirm: true }}
					machine={ctx.machine}
					actionLabel="Migrate"
					run={action.run}
					onCancel={() => setIsConfirming(false)}
					onDone={() => {
						setIsConfirming(false);
						plan.refresh();
					}}
				/>
			) : (
				<div className="row-actions">
					<button type="button" className="btn sm" onClick={() => setIsConfirming(true)}>
						Migrate
					</button>
				</div>
			)}
		</div>
	);
};

// Disk: the trash and what crew left behind, each emptied after a confirm with what it costs.
import { useState } from 'react';
import { useCrew, useCrewAction } from '../api.js';
import { countOf } from '../../count.js';
import { Confirm, ResultLine, type SetupContext, describeSize } from '../common.js';
import { type TrashInfo, countLeftovers, describeLeftovers } from './settings.js';

export const DiskSection = ({ ctx }: { ctx: SetupContext }) => {
	const trash = useCrew<TrashInfo>(ctx.machine, { type: 'trash' });
	const leftovers = useCrew<unknown>(ctx.machine, { type: 'clean_dry_run' });
	const action = useCrewAction(ctx.machine);
	const [confirming, setConfirming] = useState<'trash' | 'clean' | null>(null);
	const leftCount = countLeftovers(leftovers.data);

	return (
		<div className="cfg-sec">
			<div className="cfg-h">
				<span className="label">Disk</span>
			</div>
			<div className="box flat">
				<div className="box-row">
					<span className={`dot ${trash.data?.bytes ? 'run' : 'ring'}`} />
					<span className="sub">
						<b>Trash</b>
						<span className="m">
							{trash.data?.entries
								? `${countOf(trash.data.entries, 'removed checkout')} · ${describeSize(trash.data.bytes)}`
								: 'empty'}
						</span>
					</span>
					<button
						type="button"
						className="btn sm"
						disabled={!trash.data?.entries}
						onClick={() => setConfirming('trash')}
					>
						Empty now
					</button>
				</div>
				<div className="box-row">
					<span className="dot ring" />
					<span className="sub">
						<b>Left behind</b>
						<span className="m">
							{leftCount
								? `${countOf(leftCount, 'thing')} crew can clear: old checks, logs of removed worktrees, stale locks`
								: 'nothing to clear'}
						</span>
					</span>
					<button
						type="button"
						className="btn sm"
						disabled={!leftCount}
						onClick={() => setConfirming('clean')}
					>
						Clean up
					</button>
				</div>
			</div>
			<small className="m">
				crew sweeps these on its own at most hourly; Clean up runs it now.
			</small>
			{confirming === 'trash' && (
				<Confirm
					title="Empty the trash?"
					why={
						<p className="fail-why">
							The removed checkouts in the trash are deleted for good:{' '}
							{describeSize(trash.data?.bytes)}.
						</p>
					}
					command={{ type: 'trash_empty', confirm: true }}
					machine={ctx.machine}
					actionLabel="Empty the trash"
					run={action.run}
					onCancel={() => setConfirming(null)}
					onDone={() => {
						setConfirming(null);
						trash.refresh();
					}}
				/>
			)}
			{confirming === 'clean' && (
				<Confirm
					title="Clean up what's left behind?"
					why={
						<>
							<p className="fail-why">crew removes what it no longer needs:</p>
							<ul className="cost">
								{describeLeftovers(leftovers.data).map((line) => (
									<li key={line}>{line}</li>
								))}
							</ul>
						</>
					}
					command={{ type: 'clean', confirm: true }}
					machine={ctx.machine}
					actionLabel="Clean up"
					run={action.run}
					onCancel={() => setConfirming(null)}
					onDone={() => {
						setConfirming(null);
						leftovers.refresh();
						trash.refresh();
					}}
				/>
			)}
			<ResultLine reply={action.last} />
		</div>
	);
};

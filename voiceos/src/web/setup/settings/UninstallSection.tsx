// Uninstall, on this Mac only: keep ~/.crew or purge it, each behind a typed confirm.
import { useState } from 'react';
import { LOCAL_MACHINE } from '../../../shared/machine-ref.js';
import { useCrewAction } from '../api.js';
import { Confirm } from '../common.js';

interface UninstallProps {
	onUninstalled: () => void;
}

export const UninstallSection = ({ onUninstalled }: UninstallProps) => {
	const [mode, setMode] = useState<'keep' | 'purge' | null>(null);
	const action = useCrewAction(LOCAL_MACHINE);

	return (
		<div className="cfg-sec danger-zone">
			<div className="cfg-h">
				<span className="label">Uninstall</span>
			</div>
			<p className="fail-why">
				Stops every dev server and crew's server, and removes crew. Your config and worktrees in
				~/.crew are kept unless you also purge.
			</p>
			{mode ? (
				<Confirm
					title={mode === 'purge' ? 'Uninstall crew and delete ~/.crew?' : 'Uninstall crew?'}
					why={
						<p className="fail-why">
							{mode === 'purge'
								? 'Every worktree, its uncommitted work, and crew’s config go with it. This cannot be undone.'
								: 'crew and its server go; ~/.crew stays, so a reinstall picks up where you left off.'}
						</p>
					}
					command={{ type: 'uninstall', mode, confirm: true }}
					machine={LOCAL_MACHINE}
					actionLabel={mode === 'purge' ? 'Uninstall and purge' : 'Uninstall'}
					typed="uninstall"
					run={action.run}
					onCancel={() => setMode(null)}
					onDone={onUninstalled}
				/>
			) : (
				<div className="row-actions">
					<button type="button" className="btn danger" onClick={() => setMode('keep')}>
						Uninstall crew…
					</button>
					<button type="button" className="btn ghost" onClick={() => setMode('purge')}>
						Uninstall and purge…
					</button>
				</div>
			)}
		</div>
	);
};

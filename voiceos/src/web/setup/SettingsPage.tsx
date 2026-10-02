// crew on one machine: a new release, this machine's addresses, the dev proxy, disk (trash and
// leftovers), moving to another machine, pre-2.0 workspaces, crew's own log, and uninstall.
import { useState } from 'react';
import { LOCAL_MACHINE } from '../../shared/machine-ref.js';
import { PageHead, type SetupContext } from './common.js';
import { CrewLog } from './settings/CrewLog.js';
import { DiskSection } from './settings/DiskSection.js';
import { MachineConfig } from './settings/MachineConfig.js';
import { MigrateSection } from './settings/MigrateSection.js';
import { MoveSection } from './settings/MoveSection.js';
import { UninstallSection } from './settings/UninstallSection.js';
import { UpdateRow } from './settings/UpdateRow.js';

export const SettingsPage = ({ ctx }: { ctx: SetupContext }) => {
	const [isUninstalled, setIsUninstalled] = useState(false);
	const isLocal = ctx.machine === LOCAL_MACHINE;

	if (isUninstalled) {
		return (
			<section className="page narrow" aria-label="crew is uninstalled">
				<PageHead
					title="crew is uninstalled"
					lead="Its server is stopping, so this page stops answering. To come back, install crew again and run crew."
				/>
			</section>
		);
	}

	return (
		<section className="page cfg" aria-label="Settings">
			<PageHead title="Settings" lead={`crew on ${ctx.machineTitle}.`} />
			{isLocal && <UpdateRow />}
			<MachineConfig ctx={ctx} />
			<DiskSection ctx={ctx} />
			<MoveSection ctx={ctx} />
			<MigrateSection ctx={ctx} />
			<CrewLog ctx={ctx} />
			{isLocal && <UninstallSection onUninstalled={() => setIsUninstalled(true)} />}
		</section>
	);
};

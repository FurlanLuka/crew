// A new release of crew on this Mac: always read and run here, whichever machine Set up is on. The
// server keeps running the old one until it is restarted.
import { useState } from 'react';
import { LOCAL_MACHINE } from '../../../shared/machine-ref.js';
import { isOk, runCrew, useCrew, useCrewAction } from '../api.js';
import { ResultLine } from '../common.js';
import { type UpdateCheck, describeUpdate } from './settings.js';

export const UpdateRow = () => {
	const check = useCrew<UpdateCheck>(LOCAL_MACHINE, { type: 'update_check' });
	const action = useCrewAction(LOCAL_MACHINE);
	const [installed, setInstalled] = useState<string | null>(null);
	const update = check.data ? describeUpdate(check.data) : null;

	if (!installed && update?.kind !== 'available') {
		return update ? <p className="m update-line">{update.text}</p> : null;
	}

	const release = update?.kind === 'available' ? update : null;

	return (
		<div className="update-row">
			<span className="dot ok" />
			<span className="sub">
				<b>
					{installed ? `crew ${installed} is installed` : `crew ${release?.latest ?? ''} is out`}
				</b>
				<span className="m">
					{installed
						? "crew's server keeps running the old one until you restart it"
						: `you have ${release?.current ?? ''} · crew's server keeps running until you restart it · other machines are updated from here after`}
				</span>
			</span>
			<span className="row-actions">
				{installed ? (
					<button
						type="button"
						className="btn sm primary"
						onClick={() => void runCrew(LOCAL_MACHINE, { type: 'server_restart' })}
					>
						Restart crew's server
					</button>
				) : (
					<button
						type="button"
						className="btn sm primary"
						disabled={action.isBusy}
						onClick={async () => {
							if (isOk(await action.run({ type: 'update' }))) {
								setInstalled(release?.latest ?? 'the new release');
							}
						}}
					>
						{action.isBusy ? 'Updating…' : 'Update'}
					</button>
				)}
			</span>
			<ResultLine reply={action.last && !isOk(action.last) ? action.last : null} />
		</div>
	);
};

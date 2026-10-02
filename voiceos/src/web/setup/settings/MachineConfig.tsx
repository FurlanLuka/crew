// This machine's addresses and the dev proxy, set with crew config set.
import { type FormEvent, useState } from 'react';
import { useCrew, useCrewAction, isOk } from '../api.js';
import { CommandLine } from '../CommandLine.js';
import { ResultLine, type SetupContext } from '../common.js';
import {
	CONFIG_FIELDS,
	type ConfigShow,
	describeTrust,
	planConfigSave,
	showConfigValue,
} from './settings.js';

export const MachineConfig = ({ ctx }: { ctx: SetupContext }) => {
	const config = useCrew<ConfigShow>(ctx.machine, { type: 'config_show' });
	const proxy = useCrew<Record<string, unknown>>(ctx.machine, { type: 'proxy_status' });
	const action = useCrewAction(ctx.machine);
	const [edits, setEdits] = useState<Partial<Record<keyof ConfigShow, string>>>({});
	const [trust, setTrust] = useState<string | null>(null);
	const changed = planConfigSave(config.data, edits);

	const save = async (event: FormEvent) => {
		event.preventDefault();

		for (const command of changed) {
			if (!isOk(await action.run(command))) {
				return;
			}
		}

		setEdits({});
		config.refresh();
	};

	const isAnswering = proxy.data?.listening === true || proxy.data?.Listening === true;

	return (
		<form className="cfg-sec" onSubmit={(event) => void save(event)}>
			<div className="cfg-h">
				<span className="label">This machine</span>
				<small className="m">
					addresses and the dev proxy: nice URLs for every server, also from your phone
				</small>
			</div>
			<div className="cfg-grid">
				{CONFIG_FIELDS.map((field) => (
					<label key={field.key} className="field">
						<span>{field.label}</span>
						<input
							type="text"
							autoComplete="off"
							placeholder={field.placeholder || undefined}
							value={edits[field.key] ?? showConfigValue(field, config.data)}
							onChange={(event) => setEdits({ ...edits, [field.key]: event.target.value })}
						/>
						{field.hint && <small>{field.hint}</small>}
					</label>
				))}
			</div>
			<div className="row-actions">
				<span className="m">
					<span className={`dot ${isAnswering ? 'ok' : 'ring'}`} />{' '}
					{isAnswering ? 'proxy answering' : 'proxy not running'}
				</span>
				<button
					type="submit"
					className="btn sm primary"
					disabled={changed.length === 0 || action.isBusy}
				>
					Save
				</button>
				<button
					type="button"
					className="btn sm"
					onClick={async () => {
						const reply = await action.run({ type: 'proxy_trust' });

						setTrust(isOk(reply) && 'json' in reply ? describeTrust(reply.json) : null);
					}}
				>
					Trust on other devices
				</button>
				<button
					type="button"
					className="btn sm ghost"
					onClick={() => void action.run({ type: 'config_refresh' })}
				>
					Refresh tmux config
				</button>
			</div>
			<CommandLine commands={changed} machineTitle={ctx.machineTitle} />
			{trust ? <p className="result-line ok">{trust}</p> : <ResultLine reply={action.last} />}
		</form>
	);
};

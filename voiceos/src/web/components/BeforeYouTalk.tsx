// The first time Voice OS lacks a key: the mic and the missing keys on one sheet. crew checks each
// key before saving it (a 401/403 is a rejection, said in crew's own words); keys stay on This Mac.
import { type FormEvent, useState } from 'react';
import { LOCAL_MACHINE } from '../../shared/machine-ref.js';
import type { State } from '../../shared/protocol.js';
import { isOk, readCrewLine, runCrew } from '../setup/api.js';

export type KeyName = 'anthropic' | 'soniox';

// state.setup.missing names each missing key by its file.
export const isKeyMissing = (state: State, name: KeyName): boolean =>
	state.setup.missing.some((entry) => entry.endsWith(`${name}.key`));

export const listMissingKeys = (state: State): KeyName[] =>
	(['soniox', 'anthropic'] as const).filter((name) => isKeyMissing(state, name));

interface BeforeYouTalkProps {
	state: State;
	onClose: () => void;
	onNotNow: () => void;
}

const KEY_COPY: Record<KeyName, { label: string; note: string; placeholder: string }> = {
	soniox: {
		label: 'Soniox key',
		note: 'Speech in and out · from console.soniox.com',
		placeholder: 'Soniox API key',
	},
	anthropic: {
		label: 'Anthropic key',
		note: 'Works out which session your words are for · from console.anthropic.com',
		placeholder: 'sk-ant-…',
	},
};

export const BeforeYouTalk = ({ state, onClose, onNotNow }: BeforeYouTalkProps) => {
	const missing = listMissingKeys(state);
	const [values, setValues] = useState<Partial<Record<KeyName, string>>>({});
	const [errors, setErrors] = useState<Partial<Record<KeyName, string>>>({});
	const [mic, setMic] = useState<'ask' | 'allowed' | 'denied'>('ask');
	const [isBusy, setIsBusy] = useState(false);

	const allowMic = async () => {
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

			for (const track of stream.getTracks()) {
				track.stop();
			}

			setMic('allowed');
		} catch {
			setMic('denied');
		}
	};

	const start = async (event: FormEvent) => {
		event.preventDefault();
		setIsBusy(true);
		const nextErrors: Partial<Record<KeyName, string>> = {};

		for (const name of missing) {
			const value = values[name]?.trim();

			if (!value) {
				nextErrors[name] =
					`Paste your ${name === 'anthropic' ? 'Anthropic' : 'Soniox'} key to continue`;
				continue;
			}

			const reply = await runCrew(LOCAL_MACHINE, { type: 'keys_set', name, value });

			if (!isOk(reply)) {
				nextErrors[name] = readCrewLine(reply) || 'crew could not save this key';
			}
		}

		setIsBusy(false);
		setErrors(nextErrors);

		if (Object.keys(nextErrors).length === 0) {
			onClose();
		}
	};

	return (
		<div className="vo-first">
			<form className="vf-card" role="dialog" aria-labelledby="vf-title" onSubmit={start}>
				<h1 id="vf-title">Before you talk</h1>
				<p className="lead">
					Voice OS listens through your mic and answers out loud. It needs the mic and{' '}
					{missing.length === 1 ? 'a key, which stays' : 'two keys, which stay'} on This Mac.
				</p>
				<div className="vf-rows">
					<div className="vf-mic">
						<span className="sub">
							<b>Microphone</b>
							<span className={`m ${mic === 'denied' ? 'c-crit' : ''}`}>
								{mic === 'denied'
									? "Blocked: allow it in the browser's site settings"
									: 'Your browser asks once.'}
							</span>
						</span>
						<button
							type="button"
							className="btn sm"
							disabled={mic === 'allowed'}
							onClick={() => void allowMic()}
						>
							{mic === 'allowed' ? 'Allowed' : 'Allow'}
						</button>
					</div>
					{missing.map((name) => (
						<label key={name} className="field">
							<span>{KEY_COPY[name].label}</span>
							<input
								type="password"
								autoComplete="off"
								className={errors[name] ? 'bad' : ''}
								placeholder={KEY_COPY[name].placeholder}
								value={values[name] ?? ''}
								onChange={(event) => setValues({ ...values, [name]: event.target.value })}
							/>
							<small className={errors[name] ? 'bad' : ''}>
								{errors[name] ?? KEY_COPY[name].note}
							</small>
						</label>
					))}
				</div>
				<div className="row-actions">
					<button type="submit" className="btn primary" disabled={isBusy}>
						{isBusy ? 'Checking…' : 'Start Voice OS'}
					</button>
					<button type="button" className="btn ghost" onClick={onNotNow}>
						Not now
					</button>
				</div>
				<p className="m">Text and clicks work without them.</p>
			</form>
		</div>
	);
};

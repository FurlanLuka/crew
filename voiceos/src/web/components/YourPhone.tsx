// Settings → Your phone: a code for one phone, signed in with its own key; how the phone reaches this
// Mac (crew's proxy, or Tailscale, recommended, as a checklist that ticks itself); and every phone
// with a key, each revocable. Each button runs one crew command.
import { useState } from 'react';
import { LOCAL_MACHINE } from '../../shared/machine-ref.js';
import { isOk, readCrewLine, runCrew, useCrew } from '../setup/api.js';
import { describeTrust } from '../setup/settings/settings.js';
import { useNow } from '../use-now.js';
import {
	describePhone,
	isPhoneCode,
	isRecentlyOpened,
	listTailscaleSteps,
	type PhoneCode,
	type PhoneRow,
	readPhoneName,
	type TailscaleStatus,
	toQrPath,
	VIA_LABELS,
} from '../your-phone.js';

const TAILSCALE_DNS = 'https://login.tailscale.com/admin/dns';

export const QrCode = ({ text }: { text: string }) => {
	const { size, path } = toQrPath(text);

	return (
		<svg
			viewBox={`-2 -2 ${size + 4} ${size + 4}`}
			shapeRendering="crispEdges"
			role="img"
			aria-label="QR code of the phone's link"
		>
			<path d={path} fill="#000" />
		</svg>
	);
};

interface PairingProps {
	code: PhoneCode | null;
	isBusy: boolean;
	trustLine: string | null;
	onNewCode: () => void;
	onTrust: () => void;
}

export const Pairing = ({ code, isBusy, trustLine, onNewCode, onTrust }: PairingProps) => (
	<div className="pair">
		<div className={`qr ${code ? '' : 'empty'}`}>
			{code ? <QrCode text={code.link} /> : <span>No code yet</span>}
		</div>
		<div className="steps">
			<ol>
				<li>
					<span className="n">1</span>
					<span>Scan it with the phone's camera. It opens signed in to This Mac.</span>
				</li>
				<li>
					<span className="n">2</span>
					<span>The page shows how to add it to the home screen, for iPhone or Android.</span>
				</li>
				<li>
					<span className="n">3</span>
					<span>Open it from the home screen. It stays signed in until you revoke it here.</span>
				</li>
			</ol>
			{code && (
				<div className="addr">
					Reached at <b>{code.address}</b> · {VIA_LABELS[code.via]}
				</div>
			)}
			<div className="row-actions">
				<button type="button" className="btn sm" disabled={isBusy} onClick={onNewCode}>
					{isBusy ? 'Making a code…' : 'New code'}
				</button>
				{code?.via === 'proxy' && (
					<button type="button" className="btn sm ghost" onClick={onTrust}>
						Trust crew's certificate on the phone…
					</button>
				)}
			</div>
			{trustLine && <p className="vs-note">{trustLine}</p>}
		</div>
	</div>
);

interface TailscaleCardProps {
	status: TailscaleStatus;
	isBusy: boolean;
	onServe: () => void;
	onStop: () => void;
}

export const TailscaleCard = ({ status, isBusy, onServe, onStop }: TailscaleCardProps) => {
	if (status.serving) {
		return (
			<div className="ts">
				<div className="ts-h">
					<span className="tip-k">On Tailscale</span>
					<div>
						<b>Only your devices can reach it</b>
						<p>
							The code uses the Tailscale link. Your phone needs Tailscale signed in with the same
							account.
						</p>
					</div>
					<button type="button" className="btn sm ghost" disabled={isBusy} onClick={onStop}>
						Stop serving
					</button>
				</div>
			</div>
		);
	}

	const steps = listTailscaleSteps(status);
	const [mac, https] = steps;
	const canServe = Boolean(mac?.isDone && https?.isDone);

	return (
		<div className="ts">
			<div className="ts-h">
				<span className="tip-k">Recommended</span>
				<div>
					<b>Reach it with Tailscale</b>
					<p>
						Only your own devices can reach this Mac, it works away from home, and the phone gets a
						real certificate with nothing to trust by hand.
					</p>
				</div>
			</div>
			<ol>
				{steps.map((step) => (
					<li key={step.key} data-step={step.key}>
						<span className={`ck ${step.isDone ? 'done' : 'todo'}`} aria-hidden="true">
							{step.isDone ? '✓' : ''}
						</span>
						<span>
							{step.title}
							<span className="m">{step.detail}</span>
						</span>
						{step.key === 'https' && !step.isDone ? (
							<a className="btn sm" href={TAILSCALE_DNS} target="_blank" rel="noopener noreferrer">
								Turn it on in Tailscale ↗
							</a>
						) : step.key === 'serve' ? (
							<button
								type="button"
								className="btn sm"
								disabled={!canServe || isBusy}
								onClick={onServe}
							>
								Set it up
							</button>
						) : (
							<span />
						)}
					</li>
				))}
			</ol>
			<span className="phone-note">
				On your phone, install Tailscale and sign in with the same account.
			</span>
		</div>
	);
};

interface PhonesListProps {
	phones: PhoneRow[];
	now: number;
	// Absent on a phone: revoking is the Mac's, and the server refuses it from a phone's key.
	onRevoke?: (id: string) => void;
}

export const PhonesList = ({ phones, now, onRevoke }: PhonesListProps) =>
	phones.length === 0 ? null : (
		<div className="box phones">
			{phones.map((phone) => (
				<div key={phone.id} className="box-row" data-phone={phone.id}>
					<span className={`dot ${isRecentlyOpened(phone, now) ? 'ok' : 'ring'}`} />
					<span className="sub">
						<b>{readPhoneName(phone)}</b>
						<span className="m">{describePhone(phone, now)}</span>
					</span>
					{onRevoke && (
						<button type="button" className="btn sm danger" onClick={() => onRevoke(phone.id)}>
							Revoke
						</button>
					)}
				</div>
			))}
		</div>
	);

// On a phone itself: which phones have a key, and where they are managed. Codes, Tailscale and
// Revoke are the Mac's: the server refuses them from a phone's key.
export const PhoneOnlyNote = ({ phones, now }: { phones: PhoneRow[]; now: number }) => (
	<div className="vs-sec vs-phone" id="vs-phone">
		<h2>Your phone</h2>
		<p className="vs-lead">
			This phone is signed in with its own key. New codes, Tailscale and revoking a phone are in
			Voice OS Settings on the Mac.
		</p>
		<PhonesList phones={phones} now={now} />
	</div>
);

export const YourPhone = ({ isPhoneLink = false }: { isPhoneLink?: boolean }) => {
	const phones = useCrew<PhoneRow[]>(LOCAL_MACHINE, { type: 'phones_ls' });
	const tailscale = useCrew<TailscaleStatus>(
		LOCAL_MACHINE,
		isPhoneLink ? null : { type: 'tailscale_status' },
	);
	const [code, setCode] = useState<PhoneCode | null>(null);
	const [line, setLine] = useState<string | null>(null);
	const [trustLine, setTrustLine] = useState<string | null>(null);
	const [isBusy, setIsBusy] = useState(false);
	const now = useNow(30_000);

	const run = async (command: Parameters<typeof runCrew>[1], fallback: string) => {
		setIsBusy(true);
		const reply = await runCrew(LOCAL_MACHINE, command);
		setIsBusy(false);
		setLine(isOk(reply) ? null : readCrewLine(reply) || fallback);

		return reply;
	};

	const newCode = async () => {
		const reply = await run({ type: 'phones_add' }, 'No code made.');

		if (isOk(reply) && isPhoneCode(reply.json)) {
			setCode(reply.json);
			setTrustLine(null);
		}

		phones.refresh();
	};

	const trust = async () => {
		const reply = await runCrew(LOCAL_MACHINE, { type: 'proxy_trust' });

		setTrustLine(
			(isOk(reply) && 'json' in reply ? describeTrust(reply.json) : null) ??
				(readCrewLine(reply) || 'crew could not say how to trust its certificate.'),
		);
	};

	const revoke = async (id: string) => {
		await run({ type: 'phones_rm', id }, 'Not revoked.');

		// The code on screen was that phone's: it no longer opens anything.
		if (code?.id === id) {
			setCode(null);
		}

		phones.refresh();
	};

	const setServing = async (isOn: boolean) => {
		await run({ type: isOn ? 'tailscale_serve' : 'tailscale_off' }, 'Tailscale did not change.');
		tailscale.refresh();
	};

	if (isPhoneLink) {
		return <PhoneOnlyNote phones={phones.data ?? []} now={now} />;
	}

	return (
		<div className="vs-sec vs-phone" id="vs-phone">
			<h2>Your phone</h2>
			<p className="vs-lead">
				Voice OS on your phone, signed in with its own key. Scan the code with the phone's camera.
			</p>
			<Pairing
				code={code}
				isBusy={isBusy}
				trustLine={trustLine}
				onNewCode={() => void newCode()}
				onTrust={() => void trust()}
			/>
			{tailscale.data && (
				<TailscaleCard
					status={tailscale.data}
					isBusy={isBusy}
					onServe={() => void setServing(true)}
					onStop={() => void setServing(false)}
				/>
			)}
			{line && <p className="vs-note">{line}</p>}
			<PhonesList phones={phones.data ?? []} now={now} onRevoke={(id) => void revoke(id)} />
		</div>
	);
};

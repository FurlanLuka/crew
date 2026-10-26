// Settings → Your phone, the pure half: crew's phone and Tailscale reads as the page says them, and
// the QR code as one SVG path.
import qrcode from 'qrcode-generator';

// crew server phones --json: one row per phone with its own key.
export interface PhoneRow {
	id: string;
	name: string;
	created: string;
	device?: string;
	last_seen?: string;
}

export type PhoneVia = 'tailscale' | 'proxy' | 'local';

// crew server phones add --json: the link carries the key, and crew prints it only this once.
export interface PhoneCode {
	id: string;
	name: string;
	link: string;
	address: string;
	via: PhoneVia;
}

// crew server tailscale status --json.
export interface TailscaleStatus {
	installed: boolean;
	running: boolean;
	signed_in: boolean;
	user: string;
	host: string;
	https: boolean;
	serving: boolean;
	url: string;
	detail?: string;
}

export const VIA_LABELS: Record<PhoneVia, string> = {
	tailscale: 'Tailscale, only your devices',
	proxy: "crew's proxy, on this network",
	local: 'this Mac only: a phone cannot reach it',
};

export const isPhoneCode = (value: unknown): value is PhoneCode => {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const { link, address, via } = value as Record<string, unknown>;

	return (
		typeof link === 'string' &&
		typeof address === 'string' &&
		(via === 'tailscale' || via === 'proxy' || via === 'local')
	);
};

export interface QrPath {
	size: number;
	path: string;
}

// One square per dark module, as a single path: crisp at any size, no markup injected.
export const toQrPath = (text: string): QrPath => {
	const code = qrcode(0, 'M');

	code.addData(text);
	code.make();
	const size = code.getModuleCount();
	const squares: string[] = [];

	for (let row = 0; row < size; row += 1) {
		for (let col = 0; col < size; col += 1) {
			if (code.isDark(row, col)) {
				squares.push(`M${col} ${row}h1v1h-1z`);
			}
		}
	}

	return { size, path: squares.join('') };
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Opened within this counts as in use now: its dot is green.
export const RECENT_MS = HOUR;

const plural = (count: number, word: string): string =>
	`${count} ${word}${count === 1 ? '' : 's'} ago`;

export const describeSince = (iso: string, now: number): string => {
	const ms = now - Date.parse(iso);

	if (Number.isNaN(ms)) {
		return '';
	}

	if (ms < MINUTE) {
		return 'just now';
	}

	if (ms < HOUR) {
		return plural(Math.floor(ms / MINUTE), 'minute');
	}

	return ms < DAY ? plural(Math.floor(ms / HOUR), 'hour') : plural(Math.floor(ms / DAY), 'day');
};

const formatDay = (iso: string): string =>
	new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

// "added Oct 24 · last opened 2 minutes ago"
export const describePhone = (phone: PhoneRow, now: number): string =>
	`added ${formatDay(phone.created)} · ${
		phone.last_seen ? `last opened ${describeSince(phone.last_seen, now)}` : 'not opened yet'
	}`;

// crew names a new phone "Phone"; once it opens, the device it turned out to be says more.
export const readPhoneName = (phone: PhoneRow): string =>
	phone.name === 'Phone' && phone.device ? phone.device : phone.name;

export const isRecentlyOpened = (phone: PhoneRow, now: number): boolean =>
	phone.last_seen !== undefined && now - Date.parse(phone.last_seen) < RECENT_MS;

export interface TailscaleStep {
	key: 'mac' | 'https' | 'serve';
	title: string;
	detail: string;
	isDone: boolean;
}

// The tailnet name's first label: the machine as Tailscale calls it.
const shortHost = (host: string): string => host.split('.')[0] ?? host;

const describeMac = (status: TailscaleStatus): string => {
	if (!status.installed) {
		return 'not installed · get it from tailscale.com';
	}

	if (!status.running) {
		return 'installed, not running · open Tailscale';
	}

	return status.signed_in
		? ['running', `signed in as ${status.user}`, shortHost(status.host)].filter(Boolean).join(' · ')
		: 'running, not signed in · sign in from Tailscale';
};

// The checklist, ticked from crew's read: this Mac on the tailnet, HTTPS for it, Voice OS served.
export const listTailscaleSteps = (status: TailscaleStatus): TailscaleStep[] => {
	const isMacReady = status.installed && status.running && status.signed_in;

	return [
		{ key: 'mac', title: 'Tailscale on this Mac', detail: describeMac(status), isDone: isMacReady },
		{
			key: 'https',
			title: 'HTTPS for your tailnet',
			detail: status.https ? 'on' : 'off · Tailscale gives the link its certificate',
			isDone: isMacReady && status.https,
		},
		{
			key: 'serve',
			title: 'Put Voice OS on Tailscale',
			detail: status.host ? `makes https://${status.host}` : 'makes your Mac’s Tailscale link',
			isDone: status.serving,
		},
	];
};

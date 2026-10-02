// Settings, pure: what crew update --check means for the page, the machine fields config set takes,
// and how many things a dry run lists.
import type { SetupCommand } from '../../../crew/commands.js';

export interface UpdateCheck {
	current?: string;
	latest?: string;
	available?: boolean;
	error?: string;
	// The text crew update --check prints.
	line?: string;
}

export interface ConfigShow {
	server_ip?: string;
	ssh_host?: string;
	domain?: string;
	proxy_port?: number;
	proxy_https_port?: number;
}

export interface TrashInfo {
	bytes?: number;
	entries?: number;
}

export interface ConfigField {
	key: keyof ConfigShow;
	label: string;
	hint: string;
	placeholder: string;
	// A port where crew stores 0 for "the default": shown empty, and empty saves 0.
	isDefaultingPort?: boolean;
}

export const CONFIG_FIELDS: ConfigField[] = [
	{
		key: 'server_ip',
		label: 'Server IP',
		hint: 'how other devices reach this machine',
		placeholder: '',
	},
	{
		key: 'ssh_host',
		label: 'SSH host',
		hint: 'your ssh config alias for it, for editor links',
		placeholder: '',
	},
	{
		key: 'domain',
		label: 'Proxy domain',
		hint: 'nice URLs, e.g. 192.168.1.20.nip.io',
		placeholder: '',
	},
	{
		key: 'proxy_port',
		label: 'HTTP port',
		hint: '',
		placeholder: '80 (default)',
		isDefaultingPort: true,
	},
	{
		key: 'proxy_https_port',
		label: 'HTTPS port',
		hint: '-1 turns HTTPS off',
		placeholder: '443 (default)',
		isDefaultingPort: true,
	},
];

// What a field shows for crew's value: a port at 0 is "the default" — empty, the placeholder says
// which.
export const showConfigValue = (field: ConfigField, config: ConfigShow | null): string => {
	const value = config?.[field.key];

	return field.isDefaultingPort && !value ? '' : String(value ?? '');
};

// crew migrate --dry-run --json: how many moves it would make.
export const countRows = (json: unknown): number => (Array.isArray(json) ? json.length : 0);

export type UpdateState =
	| { kind: 'available'; current: string; latest: string }
	| { kind: 'line'; text: string };

// crew update --check --json for the page: a release to install, or the line crew update --check
// prints (check.line) — crew's wording, never the page's own copy of it.
export const describeUpdate = (check: UpdateCheck): UpdateState | null => {
	if (!check.current) {
		return null;
	}

	if (check.available && check.latest && !check.error) {
		return { kind: 'available', current: check.current, latest: check.latest };
	}

	return check.line ? { kind: 'line', text: check.line } : null;
};

// The config set commands a save runs: only the fields edited away from what crew has.
export const planConfigSave = (
	config: ConfigShow | null,
	edits: Partial<Record<keyof ConfigShow, string>>,
): SetupCommand[] =>
	CONFIG_FIELDS.flatMap((field): SetupCommand[] => {
		const value = edits[field.key]?.trim();

		if (value === undefined || value === showConfigValue(field, config)) {
			return [];
		}

		return [
			{
				type: 'config_set',
				key: field.key,
				value: field.isDefaultingPort && value === '' ? '0' : value,
			},
		];
	});

const LEFTOVER_KINDS: Record<string, string> = {
	check: 'an old check',
	setup: 'setup results of a removed worktree',
	logs: 'logs of a removed worktree',
	routes: 'routes of a removed worktree',
	lock: 'a stale lock',
	trash: 'the trash',
};

// What crew clean would actually free. Its dry run also lists a git worktree prune for every pool
// repo whether or not git has anything to prune: upkeep that clean runs, not a leftover to show.
const listLeftoverRows = (json: unknown): unknown[] =>
	(Array.isArray(json) ? json : []).filter(
		(row: unknown) => (row as { kind?: unknown } | null)?.kind !== 'prune',
	);

export const countLeftovers = (json: unknown): number => listLeftoverRows(json).length;

// crew clean --dry-run --json, one line per thing crew would clear.
export const describeLeftovers = (json: unknown): string[] =>
	listLeftoverRows(json).flatMap((row: unknown) => {
		if (!row || typeof row !== 'object') {
			return [];
		}

		const { kind, path } = row as { kind?: unknown; path?: unknown };
		const what = LEFTOVER_KINDS[String(kind)] ?? String(kind ?? '');

		return [`${what}: ${String(path ?? '')}`];
	});

// crew dev proxy trust --json: what the other device opens to trust crew's CA, or null.
export const describeTrust = (json: unknown): string | null => {
	if (!json || typeof json !== 'object') {
		return null;
	}

	const { pem_url: url, fingerprint } = json as { pem_url?: unknown; fingerprint?: unknown };

	return typeof url === 'string' && url
		? `On the other device, open ${url} and trust crew's certificate${typeof fingerprint === 'string' && fingerprint ? ` (fingerprint ${fingerprint})` : ''}.`
		: null;
};

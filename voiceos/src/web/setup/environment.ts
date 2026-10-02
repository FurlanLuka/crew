// "Environment" (crew's bindings) in Set up's words: where each value comes from, crew's .env
// proposals, and a dry run's preview of what a worktree gets. Pure.

const TOKEN = /\{\{\s*([^}]+?)\s*\}\}/g;

// One token as words: {{checkout-api}} → "checkout-api's URL", {{store-front/api.port}} →
// "store-front api's port", {{worktree}} → "the worktree's name".
const describeToken = (token: string): string => {
	if (token === 'worktree') {
		return "the worktree's name";
	}

	if (token === 'workspace') {
		return "the workspace's name";
	}

	const legacy = /^(url|port):(.+)$/.exec(token);
	const [target, part] = legacy
		? [legacy[2] ?? '', legacy[1] === 'port' ? 'port' : '']
		: token.split('.');
	const [project = '', server] = (target ?? '').split('/');
	const who = server ? `${project} ${server}` : project;

	switch (part) {
		case 'port':
			return `${who}'s port`;
		case 'host':
			return `${who}'s host`;
		default:
			return `${who}'s URL`;
	}
};

export const describeBindingSource = (value: string): string => {
	const tokens = [...value.matchAll(TOKEN)].map((match) => match[1] ?? '');

	if (tokens.length === 0) {
		return `${value}, fixed`;
	}

	const words = tokens.map(describeToken).join(' and ');

	return value.replace(TOKEN, '').trim() ? `${words}, inside "${value}"` : words;
};

export interface Proposal {
	var: string;
	// The template crew would record; none when crew needs a pick (two servers on one port).
	value: string | null;
	note: string;
}

interface ScanRow {
	var: string;
	value?: string;
	port?: number;
	template?: string;
	status: string;
	detail?: string;
}

// crew add binding <p> --scan --json: what the env files propose that is not bound yet.
export const readProposals = (json: unknown): Proposal[] =>
	(Array.isArray(json) ? (json as ScanRow[]) : [])
		.filter((row) => row.status === 'proposed' || row.status === 'ambiguous')
		.map((row) => ({
			var: row.var,
			value: row.status === 'proposed' ? (row.template ?? null) : null,
			note: [
				row.value ? `=${row.value}` : '',
				row.status === 'proposed' && row.template
					? `looks like ${describeBindingSource(row.template)}`
					: '',
				row.detail ?? '',
			]
				.filter(Boolean)
				.join(' · '),
		}));

export interface PreviewRow {
	worktree: string;
	value: string | null;
	error: string | null;
}

interface DryRunDoc {
	error?: string;
	previews?: { ref: string; value: string; resolved: boolean; running: boolean; detail?: string }[];
}

// crew add binding … --dry-run --json: the template's error, or what each worktree would get.
export const readPreview = (json: unknown): { error: string | null; rows: PreviewRow[] } => {
	const doc = (json && typeof json === 'object' ? json : {}) as DryRunDoc;

	return {
		error: doc.error || null,
		rows: (doc.previews ?? []).map((preview) => ({
			worktree: preview.ref,
			value: preview.resolved ? preview.value : null,
			error: preview.resolved ? null : (preview.detail ?? 'does not resolve'),
		})),
	};
};

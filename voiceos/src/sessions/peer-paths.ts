// Which files one session may show another: inside its own folders, and never a secret. A secret
// moves only through request_secret, with the developer's OK.
import { isAbsolute, relative, resolve } from 'node:path';

const SECRET_NAME_PATTERNS = [
	/^\.env(\..*)?$/i,
	/\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i,
	/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
	/^\.(npmrc|netrc|pgpass|pypirc|git-credentials)$/i,
	/credential/i,
	/secret/i,
];
const SECRET_DIR_PATTERN = /^\.(ssh|aws|gnupg|docker|kube)$/i;

export const isSecretPath = (path: string): boolean => {
	const parts = path.split(/[\\/]/).filter(Boolean);
	const name = parts.at(-1) ?? '';

	return (
		SECRET_NAME_PATTERNS.some((pattern) => pattern.test(name)) ||
		parts.some((part) => SECRET_DIR_PATTERN.test(part))
	);
};

// A glob that could name secret files: "**/.env*" as much as ".env". Judged with its wildcards
// taken out, since any name it matches might be a secret.
export const isSecretPattern = (pattern: string): boolean =>
	pattern.split(/[{},]/).some((part) => {
		const literal = part.replace(/[*?[\]!]/g, '');

		return literal !== '' && isSecretPath(literal);
	});

// The session's folders: its worktree and any extra directories it works in.
export interface SessionRoots {
	cwd: string;
	dirs: string[];
}

// The absolute path inside one of the roots, or null when it points outside all of them.
export const resolveInsideRoots = (path: string, { cwd, dirs }: SessionRoots): string | null => {
	const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);

	return [cwd, ...dirs].some((root) => {
		const rel = relative(resolve(root), absolute);

		return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
	})
		? absolute
		: null;
};

export type SharedPath = { ok: true; path: string } | { ok: false; reason: string };

export const checkSharedPath = (path: string, roots: SessionRoots): SharedPath => {
	const inside = resolveInsideRoots(path, roots);

	if (!inside) {
		return { ok: false, reason: `${path} is outside the session's folders` };
	}

	if (isSecretPath(inside)) {
		return { ok: false, reason: `${path} looks like a secret; use request_secret` };
	}

	return { ok: true, path: inside };
};

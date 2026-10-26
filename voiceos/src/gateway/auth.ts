import { timingSafeEqual } from 'node:crypto';

export const COOKIE_NAME = 'voiceos_token';

export const areTokensEqual = (provided: string | null | undefined, expected: string): boolean => {
	if (!provided) {
		return false;
	}

	const providedBytes = Buffer.from(provided);
	const expectedBytes = Buffer.from(expected);

	return (
		providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes)
	);
};

export const parseCookies = (header: string | null): Record<string, string> => {
	const cookies: Record<string, string> = {};

	if (!header) {
		return cookies;
	}

	for (const part of header.split(';')) {
		const index = part.indexOf('=');

		if (index < 0) {
			continue;
		}

		cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
	}

	return cookies;
};

export const createSessionCookie = (token: string, secure = false): string => {
	// Host-only and SameSite=Strict: dev servers share the proxy's parent domain and must never ride it.
	const cookie = `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;

	return secure ? `${cookie}; Secure` : cookie;
};

export const readSessionCookie = (request: Request): string | undefined =>
	parseCookies(request.headers.get('cookie'))[COOKIE_NAME];

export type Authorization<P> = 'token' | P | null;

// The main token, or the key of a phone still in phones.json: looked up per request, so a removed
// phone gets no new request or connection (its open sockets are swept in server.ts). One lookup,
// and the caller learns which.
export const authorizeRequest = <P>(
	request: Request,
	token: string,
	findPhone?: (key: string) => P | null,
): Authorization<P> => {
	const provided = readSessionCookie(request);

	if (areTokensEqual(provided, token)) {
		return 'token';
	}

	return (provided && findPhone?.(provided)) || null;
};

// Behind Tailscale or crew's TLS proxy the gateway itself sees plain http; the proxy says what the phone used.
export const isSecureRequest = (request: Request): boolean =>
	request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https' ||
	request.url.startsWith('https:');

export const isOriginAllowed = (origin: string | null, allowed: string[]): boolean => {
	// A WebSocket handshake gets no CORS check: without an exact Origin match any proxied page could drive workers.
	return Boolean(origin) && allowed.includes(origin as string);
};

export interface CheckRequestParams {
	origin: string | null;
	origins: string[];
	isAuthorized: boolean;
}

export interface Refusal {
	status: number;
	text: string;
}

// Shared by /ws and /api/crew: the page's own origin, then its cookie. A cross-site page cannot
// read the answer, but a POST it makes would still run: the exact Origin match is what stops it.
export const checkRequest = ({
	origin,
	origins,
	isAuthorized,
}: CheckRequestParams): Refusal | null => {
	if (!isOriginAllowed(origin, origins)) {
		return { status: 403, text: 'origin not allowed' };
	}

	return isAuthorized ? null : { status: 401, text: 'unauthorized' };
};

export interface ListAllowedOriginsParams {
	port: number;
	proxyHost: string | null;
	proxyPort: number | null;
	proxyHttpsPort?: number | null;
	tailscaleHost?: string | null;
}

export const listAllowedOrigins = ({
	port,
	proxyHost,
	proxyPort,
	proxyHttpsPort = null,
	tailscaleHost = null,
}: ListAllowedOriginsParams): string[] => {
	const origins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];

	if (proxyHost) {
		origins.push(
			proxyPort && proxyPort !== 80 ? `http://${proxyHost}:${proxyPort}` : `http://${proxyHost}`,
		);
	}

	// When crew's proxy serves TLS, the page also loads over HTTPS, where the mic works.
	if (proxyHost && proxyHttpsPort) {
		origins.push(
			proxyHttpsPort === 443 ? `https://${proxyHost}` : `https://${proxyHost}:${proxyHttpsPort}`,
		);
	}

	// Tailscale serve terminates TLS on 443 of the machine's tailnet name.
	if (tailscaleHost) {
		origins.push(`https://${tailscaleHost}`);
	}

	return origins;
};

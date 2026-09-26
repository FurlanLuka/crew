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

export const createSessionCookie = (token: string): string => {
	// Host-only and SameSite=Strict: dev servers share the proxy's parent domain and must never ride it.
	return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
};

export const isAuthorized = (request: Request, token: string): boolean => {
	return areTokensEqual(parseCookies(request.headers.get('cookie'))[COOKIE_NAME], token);
};

export const isOriginAllowed = (origin: string | null, allowed: string[]): boolean => {
	// A WebSocket handshake gets no CORS check: without an exact Origin match any proxied page could drive workers.
	return Boolean(origin) && allowed.includes(origin as string);
};

export interface ListAllowedOriginsParams {
	port: number;
	proxyHost: string | null;
	proxyPort: number | null;
	proxyHttpsPort?: number | null;
}

export const listAllowedOrigins = ({
	port,
	proxyHost,
	proxyPort,
	proxyHttpsPort = null,
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

	return origins;
};

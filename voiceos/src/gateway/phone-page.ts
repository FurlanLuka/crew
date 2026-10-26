import type { BunRequest } from 'bun';
import { createLogger } from '../log.js';
import { createSessionCookie, isSecureRequest } from './auth.js';
import { deviceFromUserAgent, type FindPhone, type RecordPhoneSeen } from './phones.js';
import icon180 from './icons/icon-180.png' with { type: 'file' };
import icon192 from './icons/icon-192.png' with { type: 'file' };
import icon512 from './icons/icon-512.png' with { type: 'file' };

const log = createLogger('phone');

const BACKGROUND = '#0b0d10';

const INVALID_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Voice OS</title>
<style>
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: ${BACKGROUND}; color: #e6e9ee; font: 17px/1.5 -apple-system, "Segoe UI", sans-serif; }
p { max-width: 22rem; padding: 0 16px; text-align: center; }
</style>
</head>
<body><p>This link isn't valid any more. Make a new code in Voice OS Settings → Your phone.</p></body>
</html>
`;

const escapeAttribute = (value: string): string =>
	value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export const renderPhoneHead = (key: string): string => {
	const base = escapeAttribute(`/phone/${encodeURIComponent(key)}`);

	return [
		`<link rel="manifest" href="${base}/manifest.webmanifest">`,
		'<meta name="apple-mobile-web-app-capable" content="yes">',
		'<meta name="mobile-web-app-capable" content="yes">',
		'<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
		'<meta name="apple-mobile-web-app-title" content="Voice OS">',
		`<meta name="theme-color" content="${BACKGROUND}">`,
		'<link rel="apple-touch-icon" href="/icons/icon-180.png">',
		'<script>window.__VOICEOS_PHONE__=true</script>',
	].join('');
};

// Into the head, so the manifest and the flag are there before the app's script runs.
export const injectPhoneHead = (html: string, key: string): string => {
	const head = renderPhoneHead(key);
	const close = html.indexOf('</head>');

	if (close >= 0) {
		return `${html.slice(0, close)}${head}${html.slice(close)}`;
	}

	return `${head}${html}`;
};

export const buildManifest = (key: string) => {
	const start = `/phone/${encodeURIComponent(key)}`;

	return {
		name: 'Voice OS',
		short_name: 'Voice OS',
		id: start,
		start_url: start,
		scope: '/',
		display: 'standalone',
		background_color: BACKGROUND,
		theme_color: BACKGROUND,
		icons: [
			{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
			{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
			{ src: '/icons/icon-180.png', sizes: '180x180', type: 'image/png' },
		],
	};
};

const serveIcon = (path: string) => () =>
	new Response(Bun.file(path), {
		headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' },
	});

export interface PhoneRoutesParams {
	fetchAppHtml: () => Promise<Response>;
	// Off in development: the bundle is rebuilt on change there.
	cacheAppHtml: boolean;
	findPhone?: FindPhone;
	recordPhoneSeen?: RecordPhoneSeen;
}

export const createPhoneRoutes = ({
	fetchAppHtml,
	cacheAppHtml,
	findPhone,
	recordPhoneSeen,
}: PhoneRoutesParams) => {
	let cachedHtml: string | null = null;

	const readAppHtml = async (): Promise<string> => {
		if (cachedHtml) {
			return cachedHtml;
		}

		const response = await fetchAppHtml();

		if (!response.ok) {
			throw new Error(`app page answered ${response.status}`);
		}

		const html = await response.text();

		if (cacheAppHtml) {
			cachedHtml = html;
		}

		return html;
	};

	const refuse = (reason: string) => {
		log.warn('phone link refused', { reason });

		return new Response(INVALID_PAGE, {
			status: 401,
			headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
		});
	};

	return {
		// A 200, never a redirect: iOS saves the page it was shown to the home screen, and a redirect
		// would save "/" without the key, which cannot sign the installed app back in.
		'/phone/:key': async (request: BunRequest<'/phone/:key'>) => {
			const { key } = request.params;
			const phone = findPhone?.(key);

			if (!phone) {
				return refuse(findPhone ? 'unknown key' : 'phones not enabled');
			}

			let html: string;

			try {
				html = await readAppHtml();
			} catch (error) {
				log.error('app page unavailable for phone', { id: phone.id, error: String(error) });

				return new Response('Voice OS is starting. Try again in a moment.', { status: 503 });
			}

			const device = deviceFromUserAgent(request.headers.get('user-agent'));

			recordPhoneSeen?.(phone.id, device);
			log.info('phone page served', { id: phone.id, device });

			return new Response(injectPhoneHead(html, key), {
				headers: {
					'content-type': 'text/html; charset=utf-8',
					'cache-control': 'no-store',
					// The key is in this page's URL: no link out of it may carry it along.
					'referrer-policy': 'no-referrer',
					'set-cookie': createSessionCookie(key, isSecureRequest(request)),
				},
			});
		},
		'/phone/:key/manifest.webmanifest': (
			request: BunRequest<'/phone/:key/manifest.webmanifest'>,
		) => {
			const { key } = request.params;

			if (!findPhone?.(key)) {
				return refuse('unknown key (manifest)');
			}

			return new Response(JSON.stringify(buildManifest(key)), {
				headers: { 'content-type': 'application/manifest+json', 'cache-control': 'no-store' },
			});
		},
		// Public: the home-screen icon is fetched without the cookie.
		'/icons/icon-180.png': serveIcon(icon180),
		'/icons/icon-192.png': serveIcon(icon192),
		'/icons/icon-512.png': serveIcon(icon512),
	};
};

// Whether this page is Voice OS on a phone: a phone's own link (/phone/<key>, which the server marks
// with window.__VOICEOS_PHONE__), or a narrow screen at load. Decided once: turning a phone sideways
// or narrowing a desktop window never swaps the whole tree mid-conversation.
const PHONE_MAX_WIDTH = 600;

declare global {
	interface Window {
		__VOICEOS_PHONE__?: boolean;
	}
}

// A phone's link carries its key: the address must stay as it is, so the saved app opens signed in.
export const isPhonePath = (pathname: string): boolean => pathname.startsWith('/phone/');

interface PhoneSignals {
	pathname: string;
	isMarked: boolean;
	width: number;
}

export const decideIsPhone = ({ pathname, isMarked, width }: PhoneSignals): boolean =>
	isPhonePath(pathname) || isMarked || width <= PHONE_MAX_WIDTH;

export const IS_PHONE_LINK =
	typeof window !== 'undefined' &&
	(isPhonePath(window.location.pathname) || window.__VOICEOS_PHONE__ === true);

export const IS_PHONE =
	typeof window !== 'undefined' &&
	decideIsPhone({
		pathname: window.location.pathname,
		isMarked: window.__VOICEOS_PHONE__ === true,
		width: window.innerWidth,
	});

interface InstallSignals {
	isPhoneLink: boolean;
	isStandalone: boolean;
	isDismissed: boolean;
}

// The install guide: a phone's link opened in the browser, not yet saved, and not waved away.
export const shouldShowInstall = ({ isPhoneLink, isStandalone, isDismissed }: InstallSignals) =>
	isPhoneLink && !isStandalone && !isDismissed;

export type PhonePlatform = 'ios' | 'other';

// iPadOS reports itself as a Mac; its touch points give it away.
export const readPlatform = (userAgent: string, maxTouchPoints = 0): PhonePlatform =>
	/iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)
		? 'ios'
		: 'other';

// What to do once the microphone was refused: where this phone keeps that switch.
export const describeMicHelp = (platform: PhonePlatform, isStandalone: boolean): string => {
	if (platform !== 'ios') {
		return "Microphone blocked. Allow it in the browser's site settings, then hold the mic again.";
	}

	return isStandalone
		? 'Microphone blocked. Turn it on in Settings → Voice OS → Microphone, then hold the mic again.'
		: 'Microphone blocked. Turn it on in Settings → Safari → Microphone, then hold the mic again.';
};

// A phone's link opened in the browser: how to put Voice OS on the home screen, where it opens full
// screen and keeps its key. iPhone has no install prompt, so it gets the two steps; Chrome and the
// other browsers that fire beforeinstallprompt get a real Install button, with the menu as fallback.
import { useEffect, useState } from 'react';
import { readPlatform } from '../../phone.js';
import { AddBoxIcon, ShareIcon } from './phone-icons.js';

interface InstallPromptEvent extends Event {
	prompt: () => Promise<void>;
	userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// Fired once, early, often before the page has drawn: kept from the first moment for the button.
let heldPrompt: InstallPromptEvent | null = null;
const promptListeners = new Set<() => void>();

if (typeof window !== 'undefined') {
	window.addEventListener('beforeinstallprompt', (event) => {
		event.preventDefault();
		heldPrompt = event as InstallPromptEvent;

		for (const listener of promptListeners) {
			listener();
		}
	});
}

const useInstallPrompt = (): InstallPromptEvent | null => {
	const [prompt, setPrompt] = useState(heldPrompt);

	useEffect(() => {
		const update = () => setPrompt(heldPrompt);

		promptListeners.add(update);

		return () => {
			promptListeners.delete(update);
		};
	}, []);

	return prompt;
};

const DISMISSED_KEY = 'voiceos.installDismissed';

export const readInstallDismissed = (): boolean => {
	try {
		return sessionStorage.getItem(DISMISSED_KEY) === '1';
	} catch {
		return false;
	}
};

const writeInstallDismissed = (): void => {
	try {
		sessionStorage.setItem(DISMISSED_KEY, '1');
	} catch {
		// Blocked storage: the guide comes back on the next load.
	}
};

export const isStandalone = (): boolean =>
	typeof window !== 'undefined' &&
	(window.matchMedia('(display-mode: standalone)').matches ||
		(navigator as Navigator & { standalone?: boolean }).standalone === true);

const Wordmark = () => (
	<span className="wm">
		crew<span>Voice OS</span>
	</span>
);

interface InstallGuideProps {
	onDismiss: () => void;
}

export const InstallGuide = ({ onDismiss }: InstallGuideProps) => {
	const prompt = useInstallPrompt();
	const platform = readPlatform(navigator.userAgent, navigator.maxTouchPoints);

	const dismiss = () => {
		writeInstallDismissed();
		onDismiss();
	};

	const install = async () => {
		if (!prompt) {
			return;
		}

		await prompt.prompt();
		const choice = await prompt.userChoice;
		heldPrompt = null;

		if (choice.outcome === 'accepted') {
			dismiss();
		}
	};

	if (platform === 'ios') {
		return (
			<section className="inst" aria-label="Put Voice OS on your home screen">
				<div className="in">
					<Wordmark />
					<h1>Put Voice OS on your home screen</h1>
					<p className="lead">Then it opens like an app, full screen, and stays signed in.</p>
					<ol>
						<li>
							<span className="n">1</span>
							<span>
								Tap{' '}
								<span className="ico">
									<ShareIcon />
								</span>
								<b>Share</b> below
							</span>
						</li>
						<li>
							<span className="n">2</span>
							<span>
								Choose{' '}
								<span className="ico">
									<AddBoxIcon />
								</span>
								<b>Add to Home Screen</b>
							</span>
						</li>
					</ol>
					<button type="button" className="alt" onClick={dismiss}>
						Use it in Safari instead
					</button>
				</div>
			</section>
		);
	}

	return (
		<section className="inst" aria-label="Install Voice OS">
			<div className="in">
				<Wordmark />
				<h1>Install Voice OS</h1>
				<p className="lead">It opens like an app, full screen, and stays signed in.</p>
				{prompt && (
					<button type="button" className="cta" onClick={() => void install()}>
						Install
					</button>
				)}
				<p className="small">No button? Open the menu ⋮ and choose Add to home screen.</p>
				<button type="button" className="alt" onClick={dismiss}>
					Use it in the browser instead
				</button>
			</div>
		</section>
	);
};

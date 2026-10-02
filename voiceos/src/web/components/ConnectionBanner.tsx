// crew's server stopped under an open page: said on both halves, cleared on reconnect.
import { useEffect, useState } from 'react';
import type { ConnectionStatus } from '../use-connection.js';

// A blip shorter than this (a reload of the server) is not worth a banner.
const BANNER_DELAY_MS = 1200;

interface ConnectionBannerProps {
	status: ConnectionStatus;
	// In Voice OS it is one of the notices under the top bar, stacked with the others, never over
	// them; elsewhere it floats.
	isInline?: boolean;
}

export const ConnectionBanner = ({ status, isInline = false }: ConnectionBannerProps) => {
	const [isShown, setIsShown] = useState(false);
	const isDown = status === 'closed' || status === 'connecting';
	const [hasOpened, setHasOpened] = useState(status === 'open');

	useEffect(() => {
		if (status === 'open') {
			setHasOpened(true);
		}
	}, [status]);

	useEffect(() => {
		if (!isDown || !hasOpened) {
			setIsShown(false);

			return;
		}

		const timer = setTimeout(() => setIsShown(true), BANNER_DELAY_MS);

		return () => clearTimeout(timer);
	}, [isDown, hasOpened]);

	if (!isShown) {
		return null;
	}

	return (
		<div className={isInline ? 'conn inline' : 'conn'} role="status">
			<span className="dot run" />
			<b>crew's server stopped</b>
			<span>
				reconnecting… run <code>crew</code> in a terminal to start it again
			</span>
		</div>
	);
};

// The phone page fits the visible viewport, keyboard included: iOS shrinks only the visual viewport
// when the keyboard opens and scrolls the whole page to show the focused field, which pushed the top
// bar off screen and left the page scrollable. The height follows the visual viewport (--vvh) and the
// window is put back at the top, so only each screen's own list ever scrolls.
import { useEffect } from 'react';

export const usePhoneViewport = (): void => {
	useEffect(() => {
		const viewport = window.visualViewport;

		if (!viewport) {
			return;
		}

		const root = document.documentElement;

		const fit = () => {
			root.style.setProperty('--vvh', `${Math.round(viewport.height)}px`);

			if (window.scrollY !== 0) {
				window.scrollTo(0, 0);
			}
		};

		fit();
		viewport.addEventListener('resize', fit);
		viewport.addEventListener('scroll', fit);

		return () => {
			viewport.removeEventListener('resize', fit);
			viewport.removeEventListener('scroll', fit);
			root.style.removeProperty('--vvh');
		};
	}, []);
};

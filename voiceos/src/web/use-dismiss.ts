import { type RefObject, useEffect } from 'react';

// A small menu closes on Escape or a press outside it.
export const useDismiss = (
	isOpen: boolean,
	wrapRef: RefObject<HTMLElement | null>,
	onDismiss: () => void,
): void => {
	useEffect(() => {
		if (!isOpen) {
			return;
		}

		const close = (event: Event) => {
			if (
				event instanceof KeyboardEvent
					? event.key === 'Escape'
					: !wrapRef.current?.contains(event.target as Node)
			) {
				onDismiss();
			}
		};

		document.addEventListener('pointerdown', close);
		document.addEventListener('keydown', close);

		return () => {
			document.removeEventListener('pointerdown', close);
			document.removeEventListener('keydown', close);
		};
	}, [isOpen, wrapRef, onDismiss]);
};

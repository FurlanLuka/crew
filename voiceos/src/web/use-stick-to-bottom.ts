import { useEffect, useLayoutEffect, useRef } from 'react';

// Within this of the end still counts as at the end: a line of rounding, a half-rendered caret.
const PIN_SLACK_PX = 48;

// A scrolled list that stays at its end: on every new key (another session on screen), and as it
// grows while the developer is at the end. Content growth is watched, not counted: a long session
// keeps a fixed number of items, so its length stops changing while its lines keep arriving, and
// images and Markdown grow after they are added. Scrolled up to read, it stays where they left it.
export const useStickToBottom = <T extends HTMLElement>(key: string) => {
	const ref = useRef<T>(null);
	const isPinned = useRef(true);
	// The height it had when last followed: a scroll away whose event has not landed yet (a busy
	// page) still shows as distance from that end.
	const lastHeight = useRef(0);

	useLayoutEffect(() => {
		const element = ref.current;

		if (!element) {
			return;
		}

		isPinned.current = true;
		element.scrollTop = element.scrollHeight;
		lastHeight.current = element.scrollHeight;
	}, [key]);

	useEffect(() => {
		const element = ref.current;

		if (!element) {
			return;
		}

		const follow = (): void => {
			if (isPinned.current) {
				element.scrollTop = element.scrollHeight;
			}

			lastHeight.current = element.scrollHeight;
		};

		const followGrowth = (): void => {
			if (lastHeight.current - element.scrollTop - element.clientHeight > PIN_SLACK_PX) {
				isPinned.current = false;
			}

			follow();
		};

		const onScroll = (): void => {
			isPinned.current =
				element.scrollHeight - element.scrollTop - element.clientHeight <= PIN_SLACK_PX;
		};

		const mutations = new MutationObserver(followGrowth);
		const resizes = new ResizeObserver(follow);

		mutations.observe(element, { childList: true, subtree: true, characterData: true });
		resizes.observe(element);
		element.addEventListener('scroll', onScroll, { passive: true });
		// An image loading grows the list after it was added: load does not bubble, so it is caught.
		element.addEventListener('load', follow, true);

		return () => {
			mutations.disconnect();
			resizes.disconnect();
			element.removeEventListener('scroll', onScroll);
			element.removeEventListener('load', follow, true);
		};
	}, []);

	return ref;
};

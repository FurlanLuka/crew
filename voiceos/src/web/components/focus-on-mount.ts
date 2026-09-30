// A ref callback that focuses its input once, when it appears. It must be this one stable
// function: an inline `ref={(input) => input?.focus()}` is a new callback on every render, so
// React re-runs it and pulls focus back each time the component redraws (typing in a sibling field).
export const focusOnMount = (input: HTMLInputElement | null): void => {
	input?.focus();
};

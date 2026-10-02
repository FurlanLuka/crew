// A key pressed inside an open dialog is the dialog's: the page's own Esc and push-to-talk leave it.
export const isInDialog = (event: KeyboardEvent): boolean =>
	event.target instanceof Element && event.target.closest('dialog') !== null;

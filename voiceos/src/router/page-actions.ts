// What a click on the page does. Most actions are inputs as they are; a few need what the voice path
// does around its input, or the click does less than the same answer said aloud.
import { createLogger } from '../log.js';
import type { Action } from '../shared/protocol.js';
import type { Store } from '../state/store.js';
import { settleTarget } from './target.js';

const log = createLogger('page');

export const applyPageAction = (store: Store, action: Action): void => {
	// "No, here" / "Send to X" on "For X?": the held words go where the click says (debug notes 40-41:
	// the bare input only closed the ask, and the words reached no one).
	if (action.type === 'settle_target') {
		log.info('target settled from the page', { toTarget: action.toTarget });
		settleTarget(store, action.toTarget, action.at);

		return;
	}

	store.dispatch(action);
};

// Voice off and back on: what the server lets go of and takes up again. The page does its own half
// (its mic, its listening mode) from the same state.
import { createLogger } from '../log.js';
import type { Store } from '../state/store.js';

const log = createLogger('voice');

interface FollowVoiceOffParams {
	store: Store;
	onOff: () => void;
	onOn: () => void;
}

// Called on a change only, once the change has reached every listener; a boot with voice already off
// lets go at once.
export const followVoiceOff = ({ store, onOff, onOn }: FollowVoiceOffParams): (() => void) => {
	let isOff = store.state.voiceOff;

	if (isOff) {
		log.info('voice off');
		onOff();
	}

	return store.subscribe((_stamped, state) => {
		if (state.voiceOff === isOff) {
			return;
		}

		isOff = state.voiceOff;
		log.info(isOff ? 'voice off' : 'voice on');
		// After this input's listeners have run: what letting go dispatches reaches the pages after it.
		queueMicrotask(isOff ? onOff : onOn);
	});
};

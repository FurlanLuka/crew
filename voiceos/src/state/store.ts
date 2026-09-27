import type { Input, Stamped, State } from '../shared/protocol.js';
import { createLogger } from '../log.js';
import { createInitialState, reduce, type Effect } from './reducer.js';

const log = createLogger('store');

export type Listener = (stamped: Stamped, state: State) => void;
export type EffectHandler = (effect: Effect) => void | Promise<void>;

export class Store {
	private current: State = createInitialState();
	private listeners = new Set<Listener>();
	private handlers: EffectHandler[] = [];

	constructor(private now: () => number = Date.now) {}

	get state(): State {
		return this.current;
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);

		return () => this.listeners.delete(listener);
	}

	onEffect(handler: EffectHandler): void {
		this.handlers.push(handler);
	}

	dispatch(input: Input): State {
		// The one place state changes: stamping here keeps the reducer pure and replayable in every browser.
		const seq = this.current.seq + 1;
		const stamped: Stamped = { seq, at: this.now(), id: `i${seq}`, input };
		const { state, effects } = reduce(this.current, stamped);

		this.current = state;

		if (input.type !== 'text_delta') {
			log.debug('input', { seq, type: input.type, ref: 'ref' in input ? input.ref : undefined });
		}

		for (const listener of this.listeners) {
			listener(stamped, state);
		}

		for (const effect of effects) {
			this.run(effect);
		}

		return state;
	}

	private run(effect: Effect): void {
		for (const handler of this.handlers) {
			try {
				const result = handler(effect);

				if (result instanceof Promise) {
					result.catch((error: unknown) =>
						log.error('effect failed', { effect: effect.type, error: String(error) }),
					);
				}
			} catch (error) {
				log.error('effect failed', { effect: effect.type, error: String(error) });
			}
		}
	}
}

import { isOfferFresh, type Input, type Stamped, type State } from '../shared/protocol.js';
import type { ReducerResult } from './reducer.js';
import { withoutEffects } from './helpers.js';

const DEV_INPUTS = [
	'dev_start',
	'dev_restart',
	'dev_stop',
	'dev_servers',
	'dev_offer',
	'dismiss_dev_offer',
	'fix_dev',
] as const;

type DevInput = Extract<Input, { type: (typeof DEV_INPUTS)[number] }>;

const DEV_INPUT_SET = new Set<string>(DEV_INPUTS);

export const isDevInput = (input: Input): input is DevInput => DEV_INPUT_SET.has(input.type);

export const reduceDev = (state: State, input: DevInput, stamped: Stamped): ReducerResult => {
	switch (input.type) {
		case 'dev_start':
		case 'dev_restart': {
			if (!state.sessions[input.ref]) {
				return withoutEffects(state);
			}

			const action = input.type === 'dev_start' ? 'start' : 'restart';
			const devStarting = state.devStarting.includes(input.ref)
				? state.devStarting
				: [...state.devStarting, input.ref];

			return {
				state: { ...state, devStarting },
				effects: [{ type: 'dev', ref: input.ref, action }],
			};
		}

		case 'dev_stop': {
			if (!state.sessions[input.ref]) {
				return withoutEffects(state);
			}

			const { [input.ref]: _stopped, ...devServers } = state.devServers;
			const devOffer = state.devOffer?.ref === input.ref ? null : state.devOffer;

			return {
				state: {
					...state,
					devServers,
					devOffer,
					devStarting: state.devStarting.filter((startingRef) => startingRef !== input.ref),
				},
				effects: [{ type: 'dev', ref: input.ref, action: 'stop' }],
			};
		}

		case 'dev_servers': {
			const { [input.ref]: _previous, ...otherServers } = state.devServers;
			const devServers =
				input.servers.length > 0 ? { ...otherServers, [input.ref]: input.servers } : otherServers;
			const devStarting = input.isSettled
				? state.devStarting.filter((startingRef) => startingRef !== input.ref)
				: state.devStarting;

			return withoutEffects({ ...state, devServers, devStarting });
		}

		case 'dev_offer':
			return withoutEffects({ ...state, devOffer: input.offer });

		case 'dismiss_dev_offer':
			return withoutEffects({ ...state, devOffer: null });

		// Consumed once: a second "yes" or click has nothing left to fix.
		case 'fix_dev': {
			const offer = state.devOffer;

			if (!isOfferFresh(offer, stamped.at) || offer.ref !== input.ref) {
				return withoutEffects(state);
			}

			return {
				state: { ...state, devOffer: null },
				effects: [{ type: 'fix_dev', ref: offer.ref, servers: offer.servers }],
			};
		}
	}
};

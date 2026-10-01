// Activate and deactivate by voice, and the question every other tool asks when words reach a
// session that is not active. Activating looks at every worktree on every machine; nothing else does.
import { isActive } from '../shared/active.js';
import { isSwitchOfferFresh, type State, type SwitchOffer } from '../shared/protocol.js';
import { LOCAL_MACHINE, SETUP_REF, readMachine, splitRef } from '../shared/machine-ref.js';
import { toSpokenName } from '../shared/spoken.js';
import { readMachineTitle, readSessionLabel } from '../shared/machines.js';
import { findRefsByName, normalizeName } from '../router/refs.js';
import { readLabel, readScreenRef } from '../state/helpers.js';
import { createLogger } from '../log.js';
import { findMachine, findMachineSaid } from './machines.js';
import { type ToolResult, checkRef, fail, succeed } from './results.js';
import { findNamedRefs, findSessionsNamedIn } from './session-naming.js';
import type { ToolContext } from './tools.js';

const log = createLogger('tools');

// Voice OS asked "…isn't active. Activate it?" or "…Deactivate anyway?" itself: the kernel's own words
// would say it twice.
export const ACTIVATE_OFFERED_NOTE = 'activate offered';

export type ActivateDecision =
	| { kind: 'one'; ref: string }
	| { kind: 'already'; ref: string }
	| { kind: 'several'; refs: string[] }
	| { kind: 'none' };

interface DecideActivateParams {
	state: State;
	name: string;
	// A machine id, when the developer named one ("on Personal").
	machine: string | null;
}

// By the worktree's names first (ref, label, the developer's own name), then by its workspace
// ("activate scheduler": every scheduler worktree), then by the words, across all machines.
export const decideActivate = ({
	state,
	name,
	machine,
}: DecideActivateParams): ActivateDecision => {
	const candidates = machine
		? state.order.filter((ref) => readMachine(ref) === machine)
		: state.order;
	const wanted = normalizeName(
		name.replace(/^the\s+/i, '').replace(/\s+(?:workspace|worktree|session)$/i, ''),
	);
	const byName =
		state.sessions[name] && candidates.includes(name)
			? [name]
			: findRefsByName(state, name, candidates);
	const byWorkspace =
		byName.length > 0
			? byName
			: candidates.filter((ref) => normalizeName(splitRef(ref).workspace) === wanted);
	const matches =
		byWorkspace.length > 0 ? byWorkspace : findSessionsNamedIn(state, name, candidates);

	if (matches.length > 1) {
		return { kind: 'several', refs: matches };
	}

	const [ref] = matches;

	if (!ref) {
		return { kind: 'none' };
	}

	return isActive(state, ref) ? { kind: 'already', ref } : { kind: 'one', ref };
};

const joinSpoken = (names: string[]): string =>
	names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');

// "Personal has scheduler work one and work two": the machine said once, each worktree by its name
// alone (readLabel would put the machine in front of each one again).
const describeSeveral = (state: State, refs: string[]): string => {
	const machines = [...new Set(refs.map(readMachine))];
	const names = refs.map((ref) => {
		const label = toSpokenName(readSessionLabel(state, ref));

		return machines.length > 1 ? `${label} on ${readMachineTitle(state, readMachine(ref))}` : label;
	});

	return machines.length === 1
		? `${readMachineTitle(state, machines[0] ?? '')} has ${joinSpoken(names)}`
		: joinSpoken(names);
};

interface ReadMachineParams {
	state: State;
	input: Record<string, unknown>;
	toolContext: ToolContext;
}

// undefined: a machine was named that is not known — the search does not widen to every machine.
const readMachineAsked = ({
	state,
	input,
	toolContext,
}: ReadMachineParams): string | null | undefined => {
	if (typeof input.machine === 'string' && input.machine.trim()) {
		return findMachine(state, input.machine) ?? undefined;
	}

	return toolContext.utterance === undefined ? null : findMachineSaid(state, toolContext.utterance);
};

interface ActivateParams {
	state: State;
	input: Record<string, unknown>;
	toolContext: ToolContext;
}

// What "Activate it?" was asked for: a switch goes there (words said to it wait in its queue).
const readActivateOffer = (state: State, ref: string, now: number): SwitchOffer | null => {
	const offer = state.switchOffer;

	return isSwitchOfferFresh(offer, now) && offer.kind === 'activate' && offer.ref === ref
		? offer
		: null;
};

interface MoreThanStartParams {
	ref: string;
	toolContext: ToolContext;
	state: State;
}

// "Activate checkout and run the tests": activating alone never gives the session the rest.
const isMoreThanStart = async ({
	ref,
	toolContext,
	state,
}: MoreThanStartParams): Promise<boolean> => {
	const { utterance } = toolContext;

	if (utterance === undefined || toolContext.sentTo?.has(ref)) {
		return false;
	}

	const namesAnother = findSessionsNamedIn(state, utterance, state.order).some(
		(named) => named !== ref,
	);

	return (
		!namesAnother &&
		(await toolContext.judge({
			key: 'more_than_start',
			utterance,
			context: `The session: ${ref}`,
		})) === 'yes'
	);
};

// forward reaches only the session on screen: from elsewhere it is send_to.
const describeHowToSend = (ref: string, toolContext: ToolContext): string =>
	toolContext.forwardTo === ref ? 'forward that part' : `send_to ${ref} that part`;

export const activateSession = async ({
	state,
	input,
	toolContext,
}: ActivateParams): Promise<ToolResult> => {
	const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : null;
	const screen = readScreenRef(state);

	if (!name && !screen) {
		return fail('no session on screen: ask which worktree to activate');
	}

	const machine = readMachineAsked({ state, input, toolContext });

	if (machine === undefined) {
		return fail(
			`No machine called ${String(input.machine)}. Machines: ${[LOCAL_MACHINE, ...Object.keys(state.machines)].map((id) => readMachineTitle(state, id)).join(', ')}.`,
		);
	}

	const decision: ActivateDecision = name
		? decideActivate({ state, name, machine })
		: isActive(state, screen ?? '')
			? { kind: 'already', ref: screen ?? '' }
			: { kind: 'one', ref: screen ?? '' };

	log.info('activate', { kind: decision.kind });

	switch (decision.kind) {
		case 'none':
			return fail(
				`No worktree called "${name}"${machine ? ` on ${readMachineTitle(state, machine)}` : ''}. Say so in a few words; list_sessions lists what there is.`,
			);

		case 'several':
			return fail(
				`Several worktrees answer to "${name}": ${decision.refs.join(', ')}. Nothing was activated. Ask which in a few words: "${describeSeveral(state, decision.refs)}. Which?"`,
			);

		case 'already': {
			const label = toSpokenName(readLabel(state, decision.ref));

			// "Start checkout and run the tests" with checkout already up: the rest still goes to it.
			if (await isMoreThanStart({ ref: decision.ref, toolContext, state })) {
				return {
					...succeed(
						`${decision.ref} is already active. The developer also asked it something: ${describeHowToSend(decision.ref, toolContext)} now.`,
					),
					isOpen: true,
					recordAs: { name: 'activate', input: { ...input, name: decision.ref } },
				};
			}

			return {
				...succeed(`${decision.ref} is already active`),
				reply: `${label} is already active.`,
				recordAs: { name: 'activate', input: { ...input, name: decision.ref } },
			};
		}

		case 'one':
			break;
	}

	const { ref } = decision;
	const offer = readActivateOffer(state, ref, toolContext.heardFrom ?? toolContext.now());
	const recordAs = { name: 'activate', input: { ...input, name: ref } };

	if (offer?.thenSwitch) {
		toolContext.dispatch({ type: 'activate', ref });
		toolContext.dispatch({ type: 'switch_view', view: { kind: 'session', ref }, announce: true });

		return {
			...succeed(`activated ${ref} and switched there; Voice OS said so: say nothing`),
			recordAs,
		};
	}

	toolContext.dispatch({ type: 'activate', ref, announce: true });

	if (await isMoreThanStart({ ref, toolContext, state })) {
		return {
			...succeed(
				`activated ${ref}. The developer also asked it something: ${describeHowToSend(ref, toolContext)} now — it waits until the session is up.`,
			),
			isOpen: true,
			recordAs,
		};
	}

	// Voice OS says "Activated X. Switch there?" itself, or that its machine is out of reach; on its
	// own screen nothing needs saying.
	return {
		...succeed(
			screen === ref
				? `activated ${ref}: say nothing`
				: `activated ${ref}; Voice OS said so: say nothing`,
		),
		recordAs,
	};
};

export const deactivateSession = async ({
	state,
	input,
	toolContext,
}: ActivateParams): Promise<ToolResult> => {
	const named = typeof input.ref === 'string' && input.ref.trim() ? input.ref : null;
	const screen = readScreenRef(state);
	const offer = state.switchOffer;
	const saidAt = toolContext.heardFrom ?? toolContext.now();

	if (!named && !screen) {
		return fail('no session on screen: name one');
	}

	const checked = named ? checkRef(state, named) : { ok: true as const, ref: screen ?? '' };

	if (!checked.ok) {
		return checked.inactive
			? {
					...succeed(`${checked.inactive} is not active`),
					reply: `${toSpokenName(readLabel(state, checked.inactive))} isn't active.`,
				}
			: fail(checked.error);
	}

	const { ref } = checked;
	const label = toSpokenName(readLabel(state, ref));

	if (ref === SETUP_REF) {
		return { ...fail('the setup session is always active'), reply: 'Setup is always active.' };
	}

	if (!isActive(state, ref)) {
		return { ...succeed(`${ref} is not active`), reply: `${label} isn't active.` };
	}

	const isConfirmed =
		isSwitchOfferFresh(offer, saidAt) && offer.kind === 'deactivate' && offer.ref === ref;

	// "End session X" said elsewhere names exactly that session; a yes to "Deactivate anyway?" is its own.
	if (named && !isConfirmed) {
		const namedRefs = await findNamedRefs(state, toolContext, ref);

		if (namedRefs.length !== 1 || namedRefs[0] !== ref) {
			return fail(
				`Not deactivated: the developer did not name exactly one session (${namedRefs.length ? namedRefs.join(', ') : 'none'} fit). Ask which one.`,
			);
		}
	}

	const status = state.sessions[ref]?.status;

	if (!isConfirmed && (status === 'running' || status === 'blocked')) {
		toolContext.dispatch({ type: 'offer_switch', ref, kind: 'deactivate' });

		return {
			note: ACTIVATE_OFFERED_NOTE,
			recordAs: { name: 'deactivate', input: { ...input, ref } },
			...fail(
				`Not deactivated yet: ${ref} is working, and Voice OS asked "${label} is working. Deactivate anyway?" itself: say nothing.`,
			),
			isFinal: true,
		};
	}

	toolContext.dispatch({ type: 'deactivate', ref });

	return {
		...succeed(`deactivated ${ref}`),
		reply: `Deactivated ${label}.`,
		recordAs: { name: 'deactivate', input: { ...input, ref } },
	};
};

interface RefuseInactiveParams {
	ref: string;
	toolContext: ToolContext;
	// What was said to it: kept in its queue, sent once it is activated.
	words?: string;
	// Asked for by a switch: a yes activates it and goes there.
	isSwitch?: boolean;
}

// Words, a switch or a command for a session that is not active: Voice OS asks to activate it, and
// nothing reaches it until then. Its queue keeps the words — a "no" or a lapse never loses them.
export const refuseInactive = ({
	ref,
	toolContext,
	words,
	isSwitch = false,
}: RefuseInactiveParams): ToolResult => {
	if (words) {
		toolContext.dispatch({ type: 'send', ref, text: words, isSpoken: true });
	}

	toolContext.dispatch({
		type: 'offer_switch',
		ref,
		kind: 'activate',
		...(isSwitch ? { thenSwitch: true as const } : {}),
	});
	log.info('not active: asked to activate', { ref, hasWords: Boolean(words) });

	return {
		note: ACTIVATE_OFFERED_NOTE,
		...fail(
			`Nothing was done: ${ref} is not active. Voice OS asked "… isn't active. Activate it?" itself${words ? '; the words wait for it' : ''}: say nothing.`,
		),
		isFinal: true,
	};
};

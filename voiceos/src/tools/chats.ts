// Plain Claude sessions by voice: "start a new session called research in my notes folder", "remove
// research". crew keeps the list on the machine that runs them (crew chat add/rm, run there through
// the same door Set up uses); a new one is activated and starts as soon as it is listed.
import { createLogger } from '../log.js';
import type { SetupReply } from '../crew/api.js';
import {
	CHAT_WORKSPACE,
	isChatRef,
	LOCAL_MACHINE,
	readMachine,
	refOn,
	toLocalRef,
} from '../shared/machine-ref.js';
import { readMachineTitle } from '../shared/machines.js';
import type { State } from '../shared/protocol.js';
import { toSpokenName } from '../shared/spoken.js';
import { readLabel } from '../state/helpers.js';
import { findMachine, findMachineSaid } from './machines.js';
import { checkRef, fail, succeed, type ToolResult } from './results.js';
import { findNamedRefs } from './session-naming.js';
import { findNamedRef, MAX_NAME_LENGTH } from '../state/names.js';
import type { ToolContext } from './tools.js';

const log = createLogger('tools');

interface ChatToolParams {
	state: State;
	input: Record<string, unknown>;
	toolContext: ToolContext;
}

const readText = (value: unknown): string | undefined =>
	typeof value === 'string' && value.trim() ? value.trim() : undefined;

// crew's own line for a refusal ("no folder /x on this machine"), or why crew did not answer.
const describeReply = (reply: SetupReply): string => {
	if (reply.kind === 'failed') {
		return reply.error;
	}

	if (reply.kind === 'started') {
		return 'crew was started, not waited for';
	}

	const lines = `${reply.result.stderr}\n${reply.result.code === 0 ? '' : reply.result.stdout}`
		.trim()
		.split('\n');

	return (lines.at(-1) ?? '').replace(/^Error:\s*/, '') || `crew exited ${reply.result.code}`;
};

const readAddedId = (reply: SetupReply): string | null => {
	if (reply.kind !== 'ran' || reply.result.code !== 0) {
		return null;
	}

	try {
		const added = JSON.parse(reply.result.stdout) as { id?: unknown };

		return typeof added.id === 'string' ? added.id : null;
	} catch {
		return null;
	}
};

export const startChat = async ({
	state,
	input,
	toolContext,
}: ChatToolParams): Promise<ToolResult> => {
	if (!toolContext.runCrewOn) {
		return fail('Voice OS cannot run crew here: say a plain session cannot be started right now.');
	}

	const machine =
		typeof input.machine === 'string' && input.machine.trim()
			? findMachine(state, input.machine)
			: (findMachineSaid(state, toolContext.utterance) ?? LOCAL_MACHINE);

	if (!machine) {
		return fail(`No machine called ${String(input.machine)}. Say so in a few words.`);
	}

	const dir = readText(input.folder);
	const name = readText(input.name)?.slice(0, MAX_NAME_LENGTH);

	// Two sessions under one name would leave "ask research" guessing.
	if (name && findNamedRef(state, name)) {
		return fail(`Not started: a session is already called ${name}. Ask for another name.`);
	}

	const reply = await toolContext.runCrewOn(machine, {
		type: 'chat_add',
		...(dir ? { dir } : {}),
		...(name ? { name } : {}),
	});
	const id = readAddedId(reply);

	if (!id) {
		log.info('plain session not started', { machine });

		return fail(`Not started: ${describeReply(reply)}. Say so in a few words.`);
	}

	const ref = refOn(machine, `${CHAT_WORKSPACE}/${id}`);
	const where = machine === LOCAL_MACHINE ? '' : ` on ${readMachineTitle(state, machine)}`;

	log.info('plain session started', { ref });
	// Not listed yet: the activation waits for it (a few seconds), then its Claude starts.
	toolContext.dispatch({ type: 'activate', ref });

	return {
		...succeed(`started ${ref}; Voice OS said so: say nothing`),
		reply: `Started ${name ? toSpokenName(name) : 'a plain session'}${where}.`,
		recordAs: { name: 'new_session', input: { ...input, ref } },
	};
};

export const removeChat = async ({
	state,
	input,
	toolContext,
}: ChatToolParams): Promise<ToolResult> => {
	if (!toolContext.runCrewOn) {
		return fail('Voice OS cannot run crew here: say it cannot be removed right now.');
	}

	const checked = checkRef(state, input.ref);
	const ref = checked.ok ? checked.ref : (checked.inactive ?? null);

	if (!ref) {
		return fail(checked.ok ? 'no session' : checked.error);
	}

	if (!isChatRef(ref)) {
		return fail(
			`${ref} is a worktree, not a plain session: worktrees are removed in Set up. Say so; deactivate is what stops one.`,
		);
	}

	// "Remove research" names exactly that session: a guess at another would lose its conversation.
	const namedRefs = await findNamedRefs(state, toolContext, ref);

	if (namedRefs.length !== 1 || namedRefs[0] !== ref) {
		return fail(
			'Not removed: the developer did not name exactly one plain session. Ask which one.',
		);
	}

	const label = toSpokenName(readLabel(state, ref));
	const status = state.sessions[ref]?.status;

	if (input.force !== true && (status === 'running' || status === 'blocked')) {
		return fail(
			`Not removed: ${label} is working. Ask in a few words whether to remove it anyway; on a yes call remove_session again with force true.`,
		);
	}

	toolContext.dispatch({ type: 'deactivate', ref });
	const reply = await toolContext.runCrewOn(readMachine(ref), {
		type: 'chat_rm',
		id: toLocalRef(ref),
	});

	if (reply.kind !== 'ran' || reply.result.code !== 0) {
		return fail(`Stopped, but not removed: ${describeReply(reply)}. Say so in a few words.`);
	}

	log.info('plain session removed', { ref });
	// Its name goes with it: names.json keeps nothing for a session that is gone.
	toolContext.dispatch({ type: 'rename_session', ref, name: '' });

	return {
		...succeed(`removed ${ref}; Voice OS said so: say nothing`),
		reply: `Removed ${label}. Its folder stays.`,
		recordAs: { name: 'remove_session', input: { ...input, ref } },
	};
};

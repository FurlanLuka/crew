// A session on another machine is known by its ref there, prefixed with the machine's id:
// "vm1:store-front/wrk1". crew never allows ':' in a workspace or worktree name, so the prefix
// cannot be confused with a local ref, and an ask id ("ask-<ref>-…") takes the same prefix.

// The setup session's ref (sessions/setup-session.ts re-exports it for the server side).
export const SETUP_REF = 'setup';

// The id used in views for this Mac's own sessions: never a machine id (machineIdFor refuses it).
export const LOCAL_MACHINE = 'local';

// What `crew voice logs --machine=main` names: never a machine id either.
export const MAIN_MACHINE = 'main';

const SEPARATOR = ':';

export interface RefParts {
	// null: this Mac.
	machine: string | null;
	// The ref as the machine that runs the session knows it.
	local: string;
	workspace: string;
	// '' for the setup session.
	worktree: string;
}

export const splitRef = (ref: string): RefParts => {
	const at = ref.indexOf(SEPARATOR);
	const machine = at < 0 ? null : ref.slice(0, at);
	const local = at < 0 ? ref : ref.slice(at + 1);
	const [workspace = '', worktree = ''] = local.split('/');

	return { machine, local, workspace, worktree };
};

export const joinRef = (machine: string | null, local: string): string =>
	machine ? `${machine}${SEPARATOR}${local}` : local;

// Works on refs and on ask ids alike: the prefix is always outermost.
export const machineOf = (refOrId: string): string | null => splitRef(refOrId).machine;

export const toLocalRef = (refOrId: string): string => splitRef(refOrId).local;

export const isSetupRef = (ref: string): boolean => splitRef(ref).local === SETUP_REF;

// Where a session lives, for views: LOCAL_MACHINE for this Mac.
export const readMachine = (ref: string): string => machineOf(ref) ?? LOCAL_MACHINE;

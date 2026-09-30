// The one list of worktrees the main shows: its setup session, its own worktrees, and each other
// machine's last known list with the machine in every ref. A machine out of reach keeps its list,
// so its sessions never disappear while it is away.

import { joinRef } from '../shared/machine-ref.js';
import type { WorktreeInfo } from '../shared/protocol.js';

export interface ComposeWorktreesParams {
	setup: WorktreeInfo;
	local: WorktreeInfo[];
	remotes: Record<string, WorktreeInfo[]>;
}

export const composeWorktrees = ({
	setup,
	local,
	remotes,
}: ComposeWorktreesParams): WorktreeInfo[] => [
	setup,
	...local,
	...Object.entries(remotes).flatMap(([machine, worktrees]) =>
		// The label stays as that machine knows it: its name is said and shown beside it, not in it.
		worktrees.map((info) => ({ ...info, ref: joinRef(machine, info.ref) })),
	),
];

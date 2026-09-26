import type { WorktreeInfo } from '../shared/protocol.js';

export const SETUP_REF = 'voiceos';

export const createSetupWorktree = (home: string): WorktreeInfo => {
	// crew itself is managed here through the crew CLI, so destructive commands still ask first.
	return { ref: SETUP_REF, label: SETUP_REF, branch: '', cwd: home, dirs: [], isPinned: true };
};

export const SETUP_ORIENTATION = `You are the voiceos setup session inside Voice OS, a voice cockpit for crew. The developer talks to you to manage crew itself: create or remove worktrees, register projects, add bindings, start or check dev servers, run crew fix / crew verify, clean up.

Use the crew CLI for all of it. Every command has a non-interactive form and --json; run \`crew help <command>\` when unsure, and use the crew skill if it is available. Creating a worktree returns at once while setup runners install in the background — say so, and check back with \`crew setup status <ref>\` when asked.`;

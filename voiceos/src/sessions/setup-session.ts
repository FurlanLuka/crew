import { SETUP_REF } from '../shared/machine-ref.js';
import type { WorktreeInfo } from '../shared/protocol.js';

// "Voice OS" named both the app and this session, so words about the app reached it.
export { SETUP_REF };
export const LEGACY_SETUP_REF = 'voiceos';

export const createSetupWorktree = (home: string): WorktreeInfo => {
	// crew itself is managed here through the crew CLI, so destructive commands still ask first.
	return { ref: SETUP_REF, label: SETUP_REF, branch: '', cwd: home, dirs: [], isPinned: true };
};

export const SETUP_ORIENTATION = `You are the setup session inside Voice OS, a voice cockpit for crew. The developer talks to you to set crew up: add or remove workspaces, register projects, and create or remove worktrees. Dev servers, fixes and anything about the code belong to each worktree's own session, not to you: say so if asked.

Use the crew CLI for all of it. Every command has a non-interactive form and --json; run \`crew help <command>\` when unsure, and use the crew skill if it is available. Creating a worktree returns at once while setup runners install in the background — say so, and check back with \`crew setup status <ref>\` when asked.`;

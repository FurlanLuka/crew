// Every other machine's link, kept in step with the machines the state knows, and the one worktree
// list they all feed.

import { createLogger } from '../log.js';
import { diffMachines } from '../shared/machines.js';
import type { MachineConfig, Observation, State, WorktreeInfo } from '../shared/protocol.js';
import type { Effect } from '../state/reducer.js';
import { RemoteLink, type OpenTransport } from './link.js';
import { routeEffect, type HandsEffect } from './mapping.js';
import { composeWorktrees } from './worktrees.js';
import type { UpdateRemote } from './ssh.js';
import type { CrewRunner } from '../crew/adapter.js';

const log = createLogger('remote');

export interface MachineLinksOptions {
	version: string;
	mainId: string;
	runId: string;
	open: OpenTransport;
	setup: WorktreeInfo;
	getState: () => State;
	dispatch: (input: Observation) => void;
	storeMedia: (name: string, bytes: Buffer) => boolean;
	say: (text: string) => void;
	updateRemote: UpdateRemote;
	// This machine's crew, for what a remote asks the main.
	runLocalCrew: CrewRunner;
	handleLocal: (effect: HandsEffect) => void | Promise<void>;
	// A machine's link started or stopped: its dev watch follows.
	onLinkStarted?: (link: RemoteLink) => void;
	onLinkStopped?: (id: string) => void;
	// Tests reconnect at once.
	retryMs?: number;
}

const toConfigs = (state: State): MachineConfig[] =>
	Object.values(state.machines).map(({ id, host, name }) => ({ id, host, name }));

export class MachineLinks {
	private links = new Map<string, RemoteLink>();
	private configs: MachineConfig[] = [];
	private local: WorktreeInfo[] | null = null;
	private remotes: Record<string, WorktreeInfo[]> = {};

	constructor(private options: MachineLinksOptions) {}

	get(id: string): RemoteLink | undefined {
		return this.links.get(id);
	}

	// Called on every state change: cheap when the machines did not change.
	sync(): void {
		const next = toConfigs(this.options.getState());
		const { start, stop } = diffMachines(this.configs, next);

		this.configs = next;

		for (const id of stop) {
			this.links.get(id)?.stop();
			this.links.delete(id);
			delete this.remotes[id];
			this.options.onLinkStopped?.(id);
			log.info('link stopped', { machine: id });
		}

		for (const machine of start) {
			const link = new RemoteLink({
				machine,
				version: this.options.version,
				mainId: this.options.mainId,
				runId: this.options.runId,
				open: this.options.open,
				getState: this.options.getState,
				dispatch: this.options.dispatch,
				setWorktrees: (id, worktrees) => this.setRemoteWorktrees(id, worktrees),
				storeMedia: this.options.storeMedia,
				say: (text) => this.options.say(text),
				updateRemote: this.options.updateRemote,
				runLocalCrew: this.options.runLocalCrew,
				...(this.options.retryMs !== undefined ? { retryMs: this.options.retryMs } : {}),
			});

			this.links.set(machine.id, link);
			this.options.onLinkStarted?.(link);
			link.start();
		}

		// A rename reaches the link's words (the recap) without restarting it.
		for (const machine of next) {
			const link = this.links.get(machine.id);

			if (link) {
				link.rename(machine.name);
			}
		}

		if (stop.length > 0) {
			this.dispatchWorktrees();
		}
	}

	route = (effect: Effect): void | Promise<void> => {
		const route = routeEffect(effect);

		if (route.kind === 'local') {
			return this.options.handleLocal(route.effect);
		}

		if (route.kind === 'remote') {
			const link = this.links.get(route.machine);

			if (!link) {
				log.warn('effect for a machine with no link', {
					machine: route.machine,
					type: effect.type,
				});

				return;
			}

			link.send(route.effect);
		}
	};

	setLocalWorktrees(worktrees: WorktreeInfo[] | null): void {
		if (worktrees) {
			this.local = worktrees;
		}

		this.dispatchWorktrees();
	}

	private setRemoteWorktrees(id: string, worktrees: WorktreeInfo[]): void {
		if (!this.links.has(id)) {
			return;
		}

		this.remotes[id] = worktrees;
		this.dispatchWorktrees();
	}

	private dispatchWorktrees(): void {
		this.options.dispatch({
			type: 'worktrees',
			worktrees: composeWorktrees({
				setup: this.options.setup,
				local: this.local ?? [],
				remotes: this.remotes,
			}),
		});
	}

	stopAll(): void {
		for (const link of this.links.values()) {
			link.stop();
		}
	}
}

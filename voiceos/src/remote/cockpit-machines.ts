// The cockpit's other machines, wired: their links, a dev watch per machine, the one worktree list,
// and machines.json kept in step with the state (crew writes it; this reads it back).

import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { join } from 'node:path';
import type { CrewAdapter, CrewRunner } from '../crew/adapter.js';
import { DevWatch, type DevSay } from '../dev/watch.js';
import { createLogger } from '../log.js';
import { storeMediaBytes } from '../sessions/media.js';
import type { SessionManager } from '../sessions/manager.js';
import { createSetupWorktree } from '../sessions/setup-session.js';
import { isMachineReachable, toMachineConfigs } from '../shared/machines.js';
import { LOCAL_MACHINE, machineOf } from '../shared/machine-ref.js';
import type { State } from '../shared/protocol.js';
import type { MachineChange } from '../state/reducer.js';
import type { Store } from '../state/store.js';
import { VERSION } from '../version.js';
import { createRemoteDevCrew } from './dev-crew.js';
import type { OpenTransport } from './link.js';
import { MachineLinks } from './links.js';
import { readMachinesFile, readMainId, sameMachines } from './machines-file.js';
import { openSshTransport, updateRemoteCrew, type UpdateRemote } from './ssh.js';

const log = createLogger('remote');

export interface CockpitMachinesOptions {
	store: Store;
	voiceDir: string;
	home: string;
	mediaDir: string;
	crew: CrewAdapter;
	runCrew: CrewRunner;
	manager: SessionManager;
	say: (text: string) => void;
	sayLine: DevSay;
	// A machine's status changed: crew voice machines ls reads it from the recorded state.
	onStatusesChanged: () => void;
	// How a machine is reached, and updated; SSH unless a test says otherwise.
	open?: OpenTransport;
	updateRemote?: UpdateRemote;
}

// Each machine's status as recorded for crew voice machines ls.
export const readMachineStatuses = (
	state: State,
): Record<string, { status: string; detail: string | null }> =>
	Object.fromEntries(
		Object.values(state.machines).map((machine) => [
			machine.id,
			{ status: machine.status, detail: machine.detail },
		]),
	);

// crew voice machines is the one writer of machines.json, under its lock. Pure.
export const toMachinesArgs = (change: MachineChange): string[] => {
	switch (change.kind) {
		case 'add':
			return ['voice', 'machines', 'add', change.host, `--name=${change.name}`];
		case 'rename':
			return ['voice', 'machines', 'rename', change.id, change.name];
		case 'remove':
			return ['voice', 'machines', 'rm', change.id];
	}
};

export const connectMachines = (options: CockpitMachinesOptions) => {
	const { store } = options;
	const machinesFile = join(options.voiceDir, 'machines.json');
	const devWatches = new Map<string, DevWatch>([
		[LOCAL_MACHINE, new DevWatch({ store, crew: options.crew, say: options.sayLine })],
	]);

	const links = new MachineLinks({
		version: VERSION,
		mainId: readMainId(join(options.voiceDir, 'main-id')),
		runId: randomUUID(),
		open: options.open ?? openSshTransport,
		updateRemote: options.updateRemote ?? updateRemoteCrew,
		setup: createSetupWorktree(options.home),
		getState: () => store.state,
		dispatch: (input) => store.dispatch(input),
		storeMedia: (name, bytes) => storeMediaBytes({ name, bytes, dir: options.mediaDir }),
		say: options.say,
		runLocalCrew: options.runCrew,
		handleLocal: options.manager.handle,
		onLinkStarted: (link) => {
			devWatches.set(
				link.id,
				new DevWatch({
					store,
					crew: createRemoteDevCrew(link.id, link.runCrew),
					say: options.sayLine,
					isMine: (ref) => machineOf(ref) === link.id,
					isAvailable: () => isMachineReachable(store.state, link.id),
				}),
			);
		},
		onLinkStopped: (id) => devWatches.delete(id),
	});

	const loadMachines = (): void => {
		const configs = readMachinesFile(machinesFile);

		if (!sameMachines(configs, toMachineConfigs(store.state))) {
			log.info('machines loaded', { count: configs.length });
			store.dispatch({ type: 'machines', machines: configs });
		}
	};

	const saveChange = async (change: MachineChange): Promise<void> => {
		const args = toMachinesArgs(change);
		const result = await options.runCrew(args).catch((error: unknown) => ({
			code: -1,
			stdout: '',
			stderr: String(error),
		}));

		if (result.code !== 0) {
			const reason = result.stderr.trim().replace(/^Error:\s*/, '') || `exit ${result.code}`;

			log.error('machines not saved', { change: change.kind, reason });
			options.say(`That change to your machines was not saved: ${reason}.`);
		} else {
			log.info('machines saved', { change: change.kind });
		}

		// The file is the truth: a failed change is undone, a saved one confirmed.
		loadMachines();
	};

	store.onEffect(links.route);
	store.onEffect((effect) => {
		if (effect.type === 'machines_changed') {
			return saveChange(effect.change);
		}

		for (const devWatch of devWatches.values()) {
			void devWatch.handle(effect);
		}
	});

	// Links start, stop and rename as the machines in the state do.
	let recordedStatuses = '';

	store.subscribe((_stamped, state) => {
		queueMicrotask(() => links.sync());

		const statuses = JSON.stringify(readMachineStatuses(state));

		if (statuses !== recordedStatuses) {
			recordedStatuses = statuses;
			options.onStatusesChanged();
		}
	});

	loadMachines();

	try {
		watch(options.voiceDir, (_event, file) => {
			if (file === 'machines.json') {
				loadMachines();
			}
		});
	} catch (error) {
		log.warn('machines file not watched; read on each poll', { error: String(error) });
	}

	return {
		loadMachines,
		refreshWorktrees: async (): Promise<void> => {
			try {
				links.setLocalWorktrees(await options.crew.listWorktrees());
			} catch (error) {
				log.warn('worktree refresh failed', { error: String(error) });
				// The last list stands (the setup session alone before any list came).
				links.setLocalWorktrees(null);
			}
		},
		monitorDevServers: async (): Promise<void> => {
			await Promise.all([...devWatches.values()].map((devWatch) => devWatch.monitor()));
		},
		stop: () => links.stopAll(),
	};
};

// Another machine's crew, asked over its link: refs lose the machine on the way out and gain it on
// the way back, so the dev watch reads it like this Mac's.

import { joinRef, toLocalRef } from '../shared/machine-ref.js';
import { CrewAdapter, type CrewRunner } from '../crew/adapter.js';
import type { DevCrew } from '../dev/watch.js';

export const createRemoteDevCrew = (machine: string, runCrew: CrewRunner): DevCrew => {
	const crew = new CrewAdapter(runCrew);

	return {
		readDevRoutes: async () =>
			(await crew.readDevRoutes()).map((route) => ({
				...route,
				worktree: joinRef(machine, route.worktree),
			})),
		checkServers: (ref, options) => crew.checkServers(toLocalRef(ref), options),
		runDev: (ref, action) => crew.runDev(toLocalRef(ref), action),
		readFixPrompt: (ref, timeoutMs) => crew.readFixPrompt(toLocalRef(ref), timeoutMs),
	};
};

import type { CrewAdapter } from '../crew/adapter.js';
import type { DevServer } from '../shared/protocol.js';
import type { Effect } from '../state/reducer.js';
import type { Store } from '../state/store.js';
import type { SpeechPriority } from '../speech/queue.js';
import { createLogger } from '../log.js';
import {
	confirmServersDown,
	buildFallbackFixPrompt,
	joinNames,
	decideStartReply,
	toServers,
	formatVerdictLine,
	type RouteRow,
	type Suspect,
} from './servers.js';

const log = createLogger('dev');
const FIX_PROMPT_TIMEOUT_MS = 20_000;

export type DevCrew = Pick<
	CrewAdapter,
	'runDev' | 'checkServers' | 'readDevRoutes' | 'readFixPrompt'
>;

interface DevLine {
	text: string;
	priority: SpeechPriority;
	ref: string;
	// Said with the worktree's name only when it is not on screen.
	isNamed: true;
	// Said right after the developer asked; the verdict that comes later is an announcement.
	isReply: boolean;
	isAsking: boolean;
}

export type DevSay = (line: DevLine) => void;

export interface DevWatchOptions {
	store: Store;
	crew: DevCrew;
	say: DevSay;
	now?: () => number;
	fixPromptTimeoutMs?: number;
}

interface SayParams {
	ref: string;
	text: string;
	priority: SpeechPriority;
	isReply?: boolean;
	isAsking?: boolean;
}

export class DevWatch {
	private now: () => number;
	// A second look started while one runs would read the same "before" and announce a crash twice.
	private looking: Promise<void> | null = null;
	// Per worktree, servers that looked down and are not announced yet.
	private suspects = new Map<string, Suspect[]>();

	constructor(private options: DevWatchOptions) {
		this.now = options.now ?? Date.now;
	}

	handle = async (effect: Effect): Promise<void> => {
		if (effect.type === 'dev') {
			return this.run(effect.ref, effect.action);
		}

		if (effect.type === 'fix_dev') {
			return this.fix(effect.ref, effect.servers);
		}
	};

	monitor(): Promise<void> {
		this.looking ??= this.lookAll().finally(() => {
			this.looking = null;
		});

		return this.looking;
	}

	private async loadRoutes(): Promise<RouteRow[] | null> {
		try {
			return await this.options.crew.readDevRoutes();
		} catch (error) {
			log.warn('dev status failed', { error: String(error) });

			return null;
		}
	}

	private async lookAll(): Promise<void> {
		const { store, crew } = this.options;
		const routes = await this.loadRoutes();

		if (routes === null) {
			return;
		}

		const running = new Set(
			routes.map((route) => route.worktree).filter((ref) => store.state.sessions[ref]),
		);

		for (const ref of Object.keys(store.state.devServers)) {
			if (!running.has(ref) && !store.state.devStarting.includes(ref)) {
				store.dispatch({ type: 'dev_servers', ref, servers: [], isSettled: true });
			}
		}

		for (const ref of running) {
			if (store.state.devStarting.includes(ref)) {
				continue;
			}

			try {
				const previous = store.state.devServers[ref];
				const servers = toServers({ ref, rows: await crew.checkServers(ref), routes });

				store.dispatch({ type: 'dev_servers', ref, servers, isSettled: false });

				const { announce, suspects } = confirmServersDown({
					suspects: this.suspects.get(ref) ?? [],
					previous,
					next: servers,
					now: this.now(),
				});

				this.suspects.set(ref, suspects);

				if (suspects.length > 0) {
					log.info('dev server looks down, checking again', {
						ref,
						suspects: suspects.map((suspect) => suspect.name),
					});
				}

				if (announce.length > 0) {
					log.warn('dev server went down', { ref, died: announce });
					this.offer(ref, announce);
					this.say({
						ref,
						text: `${joinNames(announce)} went down. Want Claude to fix it?`,
						priority: 'high',
						isAsking: true,
					});
				}
			} catch (error) {
				log.warn('dev check failed', { ref, error: String(error) });
			}
		}
	}

	private async run(ref: string, action: 'start' | 'stop' | 'restart'): Promise<void> {
		const { store, crew } = this.options;

		log.info('dev', { ref, action });

		if (action === 'stop') {
			try {
				await crew.runDev(ref, 'stop');
				this.say({ ref, text: 'dev servers stopped.', priority: 'normal', isReply: true });
			} catch (error) {
				log.warn('dev stop failed', { ref, error: String(error) });
				this.say({ ref, text: 'could not stop the dev servers.', priority: 'high', isReply: true });
			}

			return;
		}

		if (action === 'start') {
			const startReply = decideStartReply(store.state.devServers[ref]);

			if (startReply.kind === 'up') {
				this.settle(ref);
				this.say({
					ref,
					text: 'dev servers are already up.',
					priority: 'normal',
					isReply: true,
				});

				return;
			}

			if (startReply.kind === 'failing') {
				this.settle(ref);
				this.offer(ref, startReply.servers);
				this.say({
					ref,
					text: `${joinNames(startReply.servers)} ${startReply.servers.length === 1 ? 'is' : 'are'} failing. Want Claude to fix it?`,
					priority: 'high',
					isReply: true,
					isAsking: true,
				});

				return;
			}
		}

		this.say({
			ref,
			text: action === 'start' ? 'starting dev servers.' : 'restarting dev servers.',
			priority: 'low',
			isReply: true,
		});

		try {
			await crew.runDev(ref, action);
		} catch (error) {
			log.warn('dev start failed', { ref, action, error: String(error) });
			this.settle(ref);
			this.say({
				ref,
				text: `the dev servers did not ${action}. crew said: ${String(error).slice(0, 120)}`,
				priority: 'high',
			});

			return;
		}

		const servers = await this.look(ref);
		const verdict = formatVerdictLine(servers);

		log.info('dev verdict', {
			ref,
			states: servers.map((server) => `${server.name}:${server.state}`),
		});

		if (verdict.failing.length > 0) {
			this.offer(ref, verdict.failing);
		}

		// A failing verdict ends with the fix offer, so it asks.
		this.say({
			ref,
			text: verdict.text,
			priority: verdict.failing.length > 0 ? 'high' : 'normal',
			isAsking: verdict.failing.length > 0,
		});
	}

	private async look(ref: string): Promise<DevServer[]> {
		const { store, crew } = this.options;

		try {
			// Waits for every server's verdict; crew gives up after a minute.
			const rows = await crew.checkServers(ref, { wait: true });
			const servers = toServers({ ref, rows, routes: await crew.readDevRoutes().catch(() => []) });

			store.dispatch({ type: 'dev_servers', ref, servers, isSettled: true });

			return servers;
		} catch (error) {
			log.warn('dev check failed', { ref, error: String(error) });
			this.settle(ref);

			return [];
		}
	}

	private async loadFixPrompt(ref: string): Promise<string> {
		const { store, crew } = this.options;

		try {
			return await crew.readFixPrompt(
				ref,
				this.options.fixPromptTimeoutMs ?? FIX_PROMPT_TIMEOUT_MS,
			);
		} catch (error) {
			log.warn('crew fix prompt unavailable, using the evidence at hand', {
				ref,
				error: String(error),
			});

			return buildFallbackFixPrompt({ ref, servers: store.state.devServers[ref] ?? [] });
		}
	}

	private async fix(ref: string, failing: string[]): Promise<void> {
		const { store } = this.options;
		const prompt = await this.loadFixPrompt(ref);
		const status = store.state.sessions[ref]?.status;

		store.dispatch({ type: 'send', ref, text: prompt });
		log.info('dev fix sent', { ref, failing, status });

		const progressLine =
			status === 'stopped'
				? 'starting its Claude to fix it.'
				: status === 'idle'
					? 'Claude is on it.'
					: 'the fix is queued behind its current turn.';

		this.say({ ref, text: `fixing ${joinNames(failing)}: ${progressLine}`, priority: 'normal' });
	}

	private settle(ref: string): void {
		const { store } = this.options;

		store.dispatch({
			type: 'dev_servers',
			ref,
			servers: store.state.devServers[ref] ?? [],
			isSettled: true,
		});
	}

	private offer(ref: string, servers: string[]): void {
		this.options.store.dispatch({ type: 'dev_offer', offer: { ref, servers, at: this.now() } });
	}

	private say({ ref, text, priority, isReply = false, isAsking = false }: SayParams): void {
		this.options.say({ text, priority, ref, isNamed: true, isReply, isAsking });
	}
}

// Voice OS's top bar, docked: the crew mark (Home), Active, one tab per active session, "+" to
// activate another; on the right Discord, Claude usage and the settings gear.
import { listActiveRefs } from '../../shared/active.js';
import { machineOf } from '../../shared/machine-ref.js';
import { hasMachines, isNamed, readMachineName, readSessionLabel } from '../../shared/machines.js';
import type { State } from '../../shared/protocol.js';
import { describeSessionBadge, readRefTitle } from '../derive.js';
import type { Dispatch } from '../types.js';

interface TopBarProps {
	state: State;
	dispatch: Dispatch;
	onHome: () => void;
}

const GearIcon = () => (
	<svg
		width="15"
		height="15"
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.4"
		aria-hidden="true"
	>
		<circle cx="8" cy="8" r="2.2" />
		<path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
	</svg>
);

export const TopBar = ({ state, dispatch, onHome }: TopBarProps) => {
	const { view } = state;
	const { sevenDay, fiveHour } = state.limits;
	const discord = state.discord?.isOwnerIn ? state.discord : null;
	const usage = [sevenDay, fiveHour].filter((value) => value !== null).map((value) => `${value}%`);
	// With other machines, the usage shown is this Mac's own Claude login.
	const usageOwner = hasMachines(state) ? 'This Mac’s ' : '';

	return (
		<header className="vo-top">
			<button type="button" className="vo-brand" title="Home" onClick={onHome}>
				crew <span>voice os</span>
			</button>
			<nav className="vo-tabs" aria-label="Active sessions">
				<button
					type="button"
					className="vo-tab"
					aria-current={view.kind === 'active'}
					onClick={() => dispatch({ type: 'switch_view', view: { kind: 'active' } })}
				>
					<b>Active</b>
				</button>
				<span className="vo-sep" />
				{listActiveRefs(state).map((ref) => {
					const session = state.sessions[ref];

					if (!session) {
						return null;
					}

					const badge = describeSessionBadge(session, state.asks);
					// A name is chosen to stand alone: no machine beside it.
					const machine =
						machineOf(ref) && !isNamed(state, ref) ? readMachineName(state, ref) : null;

					return (
						<button
							type="button"
							key={ref}
							className={`vo-tab tab ${badge.isAlarm ? 'alarm' : ''}`}
							data-ref={ref}
							aria-current={view.kind === 'session' && view.ref === ref}
							title={readRefTitle(state, ref) ?? `${badge.label}`}
							onClick={() => dispatch({ type: 'switch_view', view: { kind: 'session', ref } })}
						>
							<span className={`dot ${badge.dot}`} />
							{readSessionLabel(state, ref)}
							{machine && <small>{machine}</small>}
						</button>
					);
				})}
				<button
					type="button"
					className="vo-tab vo-add"
					title="Activate a worktree"
					aria-label="Activate a worktree"
					aria-current={view.kind === 'activate'}
					onClick={() => dispatch({ type: 'switch_view', view: { kind: 'activate' } })}
				>
					+
				</button>
			</nav>
			<div className="vo-right">
				{discord && (
					<span
						className="vo-discord"
						title={
							discord.isHearing
								? 'You are in the Discord voice channel: Voice OS hears and speaks there; this page shows and types.'
								: 'You are in the Discord voice channel, but Voice OS is not hearing you: pick a mode to try again.'
						}
					>
						<span className={`dot ${discord.isHearing ? 'ok' : 'ask'}`} />
						Voice via Discord · {discord.channelName}
						{discord.isHearing ? '' : ' · not hearing'}
					</span>
				)}
				{usage.length > 0 && (
					<span className="vo-usage" title={`${usageOwner}Claude usage: this week, 5-hour window`}>
						{usage.join(' · ')}
					</span>
				)}
				<button
					type="button"
					className="vo-gear"
					aria-label="Voice OS settings"
					title="Voice OS settings"
					aria-current={view.kind === 'settings'}
					onClick={() => dispatch({ type: 'switch_view', view: { kind: 'settings' } })}
				>
					<GearIcon />
				</button>
			</div>
		</header>
	);
};

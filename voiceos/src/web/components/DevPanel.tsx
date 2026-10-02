import { type DevOffer, type DevServer, isOfferFresh } from '../../shared/protocol.js';
import type { Dispatch } from '../types.js';

const DOT_BY_SERVER_STATE: Record<DevServer['state'], string> = {
	running: 'good',
	starting: 'running',
	died: 'needs',
	'not listening': 'needs',
};

interface DevPanelProps {
	worktree: string;
	servers: DevServer[];
	isStarting: boolean;
	offer: DevOffer | null;
	// The worktree's projects with no dev servers recorded: set up in Set up, not started here.
	notSetUp?: string[];
	onSetUp?: (project: string) => void;
	dispatch: Dispatch;
}

export const DevPanel = ({
	worktree,
	servers,
	isStarting,
	offer,
	notSetUp = [],
	onSetUp,
	dispatch,
}: DevPanelProps) => {
	const isOfferShown = isOfferFresh(offer, Date.now()) && offer?.ref === worktree;

	return (
		<section className="vo-panel panel" aria-label="dev servers">
			<span className="lbl">dev servers</span>
			{notSetUp.map((project) => (
				<div key={project} className="row not-set-up">
					<span className="c-dim">{project}: not set up yet</span>
					<button type="button" className="lnk" onClick={() => onSetUp?.(project)}>
						Set up ↗
					</button>
				</div>
			))}
			{isStarting && <div className="row c-amber">starting…</div>}
			{!isStarting && servers.length === 0 && notSetUp.length === 0 && (
				<div className="row c-dim">not running</div>
			)}
			{servers.map((server) => (
				<div
					key={server.name}
					className="row devrow"
					data-server={server.name}
					data-state={server.state}
				>
					<i className={`dot ${DOT_BY_SERVER_STATE[server.state]}`} />
					<span className="c-ink">{server.name}</span>
					{server.url ? (
						<a href={server.url} target="_blank" rel="noreferrer" className="el">
							{server.url.replace(/^https?:\/\//, '')} ↗
						</a>
					) : (
						<span className="el">{server.port > 0 ? `:${server.port}` : ''}</span>
					)}
					{server.state !== 'running' && <span className="c-crit">{server.state}</span>}
				</div>
			))}
			<div className="btns">
				{servers.length === 0 && !isStarting && notSetUp.length === 0 && (
					<button
						type="button"
						className="btn sm"
						onClick={() => dispatch({ type: 'dev_start', ref: worktree })}
					>
						Start · “start dev servers”
					</button>
				)}
				{servers.length > 0 && (
					<>
						<button
							type="button"
							className="btn sm ghost"
							onClick={() => dispatch({ type: 'dev_restart', ref: worktree })}
						>
							Restart
						</button>
						<button
							type="button"
							className="btn sm ghost"
							onClick={() => dispatch({ type: 'dev_stop', ref: worktree })}
						>
							Stop
						</button>
					</>
				)}
				{isOfferShown && (
					<button
						type="button"
						className="btn sm danger"
						onClick={() => dispatch({ type: 'fix_dev', ref: worktree })}
					>
						Fix {offer.servers.join(', ')} · “yes”
					</button>
				)}
			</div>
		</section>
	);
};

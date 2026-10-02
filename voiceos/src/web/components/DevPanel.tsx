import { type DevOffer, type DevServer, isOfferFresh } from '../../shared/protocol.js';
import type { Dispatch } from '../types.js';

const DOT_BY_SERVER_STATE: Record<DevServer['state'], string> = {
	running: 'good',
	starting: 'running',
	died: 'needs',
	'not listening': 'needs',
};

// A server's link as an icon at the row's end: the URL is its tooltip and its name, never row text.
const OpenLink = ({ name, url }: { name: string; url: string }) => {
	const label = `Open ${name} (${url.replace(/^https?:\/\//, '')})`;

	return (
		<a href={url} target="_blank" rel="noreferrer" className="open-link" title={label}>
			<svg viewBox="0 0 16 16" role="img" aria-label={label}>
				<title>{label}</title>
				<path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5" />
			</svg>
		</a>
	);
};

interface DevPanelProps {
	worktree: string;
	servers: DevServer[];
	isStarting: boolean;
	offer: DevOffer | null;
	dispatch: Dispatch;
}

export const DevPanel = ({ worktree, servers, isStarting, offer, dispatch }: DevPanelProps) => {
	const isOfferShown = isOfferFresh(offer, Date.now()) && offer?.ref === worktree;

	return (
		<section className="vo-panel panel" aria-label="dev servers">
			<span className="lbl">dev servers</span>
			{isStarting && <div className="row c-amber">starting…</div>}
			{!isStarting && servers.length === 0 && <div className="row c-dim">not running</div>}
			{servers.map((server) => (
				<div
					key={server.name}
					className="row devrow"
					data-server={server.name}
					data-state={server.state}
				>
					<i className={`dot ${DOT_BY_SERVER_STATE[server.state]}`} />
					<span className="c-ink">{server.name}</span>
					{server.state !== 'running' && <span className="c-crit">{server.state}</span>}
					{server.url && <OpenLink name={server.name} url={server.url} />}
				</div>
			))}
			<div className="btns">
				{servers.length === 0 && !isStarting && (
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

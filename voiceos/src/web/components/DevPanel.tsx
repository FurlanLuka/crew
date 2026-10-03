import { useState } from 'react';
import { type DevOffer, type DevServer, isOfferFresh } from '../../shared/protocol.js';
import type { Dispatch } from '../types.js';
import { DevLogsDialog } from './DevLogsDialog.js';

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

// A server's log, beside its link: the same size, the first of the two at the row's end.
const LogsButton = ({ name, onOpen }: { name: string; onOpen: () => void }) => (
	<button
		type="button"
		className="open-link logs-link"
		aria-label={`${name} logs`}
		title="Logs"
		onClick={onOpen}
	>
		<svg viewBox="0 0 16 16" aria-hidden="true">
			<path d="M3 4h10M3 8h10M3 12h6" />
		</svg>
	</button>
);

interface DevPanelProps {
	worktree: string;
	servers: DevServer[];
	isStarting: boolean;
	offer: DevOffer | null;
	dispatch: Dispatch;
}

export const DevPanel = ({ worktree, servers, isStarting, offer, dispatch }: DevPanelProps) => {
	const isOfferShown = isOfferFresh(offer, Date.now()) && offer?.ref === worktree;
	// The server whose log opens first, by name, so the window lives through every status from crew.
	const [logsOf, setLogsOf] = useState<string | null>(null);

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
					<LogsButton name={server.name} onOpen={() => setLogsOf(server.name)} />
					{server.url && <OpenLink name={server.name} url={server.url} />}
				</div>
			))}
			{logsOf && servers.length > 0 && (
				<DevLogsDialog
					worktree={worktree}
					servers={servers}
					first={logsOf}
					dispatch={dispatch}
					onClose={() => setLogsOf(null)}
				/>
			)}
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

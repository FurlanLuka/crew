// What every Set up page shares: the context it runs in, crew's answer after an action, the confirm
// every removal goes through (with what it costs), and the failure block.
import { type ReactNode, useState } from 'react';
import type { SetupCommand } from '../../crew/commands.js';
import type { ClientMessage, State } from '../../shared/protocol.js';
import type { SetupPage } from '../router.js';
import {
	type CrewReply,
	type UseCrew,
	describeRefusal,
	isOk,
	readCrewLine,
	useCrew,
} from './api.js';
import { CommandLine } from './CommandLine.js';
import { describeCost, formatBytes } from './readers.js';

export interface SetupContext {
	state: State;
	// The machine on screen: LOCAL_MACHINE or a machine id. Everything added goes there.
	machine: string;
	machineTitle: string;
	go: (page: SetupPage, options?: { replace?: boolean }) => void;
	// "Fix with Claude", "Ask Claude": to this machine's setup chat, never interrupting it.
	askClaude: (prompt: string) => void;
	send: (message: ClientMessage) => void;
	// Voice OS on that worktree's session: activated, then on screen.
	openVoice: (sessionRef: string) => void;
}

interface ResultLineProps {
	reply: CrewReply | null;
	// Said when crew succeeded without a line of its own.
	okText?: string;
}

// crew's own words after a mutation: what it did, or why it refused.
export const ResultLine = ({ reply, okText = 'Done.' }: ResultLineProps) => {
	if (!reply) {
		return null;
	}

	const line = readCrewLine(reply);

	return (
		<p className={`result-line ${isOk(reply) ? 'ok' : 'bad'}`} role="status">
			{isOk(reply) ? `✓ ${line || okText}` : `! ${line ? describeRefusal(reply) : 'crew refused.'}`}
		</p>
	);
};

export const describeSize = (bytes: number | undefined): string =>
	bytes === undefined ? '' : formatBytes(bytes);

interface ConfirmProps {
	title: string;
	why: ReactNode;
	// The removal itself, shown as its command; its dry run says what it costs.
	command: SetupCommand;
	dryRun?: SetupCommand | null;
	// The dry run already read by the page that opens this (it needed the answer too): shown as it is,
	// never asked again.
	cost?: UseCrew<unknown>;
	machine: string;
	actionLabel: string;
	// A purge needs the word typed, not a click.
	typed?: string;
	onDone: (reply: CrewReply) => void;
	onCancel: () => void;
	run: (command: SetupCommand) => Promise<CrewReply>;
}

// Nothing is deleted without asking, and the asking says what it costs.
export const Confirm = ({
	title,
	why,
	command,
	dryRun,
	cost: given,
	machine,
	actionLabel,
	typed,
	onDone,
	onCancel,
	run,
}: ConfirmProps) => {
	const own = useCrew<unknown>(machine, given ? null : (dryRun ?? null));
	const cost = given ?? own;
	const [word, setWord] = useState('');
	const [isBusy, setIsBusy] = useState(false);
	const [reply, setReply] = useState<CrewReply | null>(null);
	const rows = cost.data ? describeCost(cost.data) : [];
	const isTypedOk = !typed || word.trim() === typed;

	const confirm = async () => {
		setIsBusy(true);
		const next = await run(command);
		setIsBusy(false);
		setReply(next);

		if (isOk(next)) {
			onDone(next);
		}
	};

	return (
		<div className="confirm" role="dialog" aria-label={title}>
			<b className="confirm-title">{title}</b>
			<div className="fail">
				<div className="fail-why">{why}</div>
				{(dryRun || given) && cost.isLoading && <p className="m">Working out what it costs…</p>}
				{rows.length > 0 && (
					<ul className="cost">
						{rows.map((row) => (
							<li key={row.label}>
								<b>{row.label}</b> <span className="m">{row.detail}</span>
							</li>
						))}
					</ul>
				)}
				{cost.reply && !isOk(cost.reply) && <p className="m">{readCrewLine(cost.reply)}</p>}
			</div>
			<CommandLine commands={[command]} />
			{typed && (
				<label className="field">
					<span>Type {typed} to confirm</span>
					<input
						type="text"
						autoComplete="off"
						value={word}
						aria-label={`Type ${typed} to confirm`}
						onChange={(event) => setWord(event.target.value)}
					/>
				</label>
			)}
			<ResultLine reply={reply && !isOk(reply) ? reply : null} />
			<div className="form-actions">
				<button
					type="button"
					className="btn danger"
					disabled={isBusy || !isTypedOk}
					onClick={() => void confirm()}
				>
					{isBusy ? 'Working…' : actionLabel}
				</button>
				<button type="button" className="btn ghost" onClick={onCancel}>
					Cancel
				</button>
			</div>
		</div>
	);
};

interface FailBlockProps {
	title: string;
	when?: string;
	steps?: { name: string; status: 'ok' | 'bad' | 'skip' }[];
	log?: string;
	why: string;
	children: ReactNode;
}

// Every failure page has the same block: what failed and when, the step it stopped at, the last
// lines of the log, one sentence on why, then the ways out.
export const FailBlock = ({ title, when, steps, log, why, children }: FailBlockProps) => (
	<div className="fail" role="alert">
		<div className="fail-h">
			<span className="dot ask" />
			<b>{title}</b>
			{when && <span className="m">{when}</span>}
		</div>
		{steps && steps.length > 0 && (
			<div className="fail-steps">
				{steps.map((step) => (
					<span key={step.name} className={step.status === 'skip' ? '' : step.status}>
						{step.name}
					</span>
				))}
			</div>
		)}
		{log && <pre className="log">{log}</pre>}
		<p className="fail-why">{why}</p>
		<div className="row-actions">{children}</div>
	</div>
);

interface PageHeadProps {
	title: string;
	lead?: ReactNode;
	children?: ReactNode;
}

export const PageHead = ({ title, lead, children }: PageHeadProps) => (
	<div className="head-row">
		<div className="head-text">
			<h1>{title}</h1>
			{lead && <p className="lead">{lead}</p>}
		</div>
		{children && <div className="row-actions">{children}</div>}
	</div>
);

export const formatAgo = (iso: string | undefined, now = Date.now()): string => {
	if (!iso) {
		return '';
	}

	const ms = now - Date.parse(iso);

	if (Number.isNaN(ms)) {
		return '';
	}

	const minutes = Math.round(ms / 60_000);

	if (minutes < 1) {
		return 'just now';
	}

	if (minutes < 60) {
		return `${minutes}m ago`;
	}

	const hours = Math.round(minutes / 60);

	return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)} days ago`;
};

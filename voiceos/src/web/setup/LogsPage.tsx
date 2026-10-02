// A worktree's logs: each dev server's output, and each project's setup runner. Following polls.
import { useState } from 'react';
import type { SetupCommand } from '../../crew/commands.js';
import { useCrew } from './api.js';
import { CommandLine } from './CommandLine.js';
import { PageHead, type SetupContext } from './common.js';
import { readLogText } from './readers.js';
import type { CrewMember, CrewProject } from './types.js';

const FOLLOW_MS = 2000;
const LINE_CHOICES = [50, 200, 1000];

interface LogsPageProps {
	ctx: SetupContext;
	worktreeRef: string;
}

interface LogTab {
	key: string;
	label: string;
	command: (lines: number) => SetupCommand;
}

export const LogsPage = ({ ctx, worktreeRef }: LogsPageProps) => {
	const members = useCrew<CrewMember[]>(ctx.machine, { type: 'show', ref: worktreeRef });
	const projects = useCrew<CrewProject[]>(ctx.machine, { type: 'ls_projects' });
	const [lines, setLines] = useState(200);
	const [isFollowing, setIsFollowing] = useState(true);
	const [chosen, setChosen] = useState<string | null>(null);
	const memberRows = members.data ?? [];
	const tabs: LogTab[] = [
		...memberRows.flatMap((member) =>
			(projects.data?.find((project) => project.name === member.name)?.dev_servers ?? []).map(
				(server): LogTab => ({
					key: `server ${server.name}`,
					label: server.name,
					command: (count) => ({
						type: 'dev_logs',
						ref: worktreeRef,
						server: server.name,
						lines: count,
					}),
				}),
			),
		),
		...memberRows.map(
			(member): LogTab => ({
				key: `setup ${member.name}`,
				label: memberRows.length > 1 ? `setup: ${member.name}` : 'setup runner',
				command: (count) => ({
					type: 'setup_logs',
					ref: worktreeRef,
					project: member.name,
					lines: count,
				}),
			}),
		),
	];
	const tab = tabs.find((candidate) => candidate.key === chosen) ?? tabs[0];
	const log = useCrew<unknown>(
		ctx.machine,
		tab ? tab.command(lines) : null,
		isFollowing ? { pollMs: FOLLOW_MS } : {},
	);
	const text = log.reply ? readLogText(log.data) || log.reply.stderr : '';

	return (
		<section className="page" aria-label={`Logs of ${worktreeRef}`}>
			<PageHead title="Logs" lead={`${worktreeRef} · ${ctx.machineTitle}`}>
				<select
					className="sel"
					aria-label="Lines"
					value={lines}
					onChange={(event) => setLines(Number(event.target.value))}
				>
					{LINE_CHOICES.map((count) => (
						<option key={count} value={count}>
							{count} lines
						</option>
					))}
				</select>
				<button
					type="button"
					className="btn"
					aria-pressed={isFollowing}
					onClick={() => setIsFollowing(!isFollowing)}
				>
					{isFollowing ? 'Following' : 'Paused'}
				</button>
			</PageHead>
			<div className="seg log-tabs" role="tablist">
				{tabs.map((candidate) => (
					<button
						key={candidate.key}
						type="button"
						role="tab"
						aria-selected={candidate.key === tab?.key}
						onClick={() => setChosen(candidate.key)}
					>
						{candidate.label}
					</button>
				))}
			</div>
			<pre className="log big">{text || (log.isLoading ? 'Reading…' : 'Nothing logged yet.')}</pre>
			<CommandLine commands={[tab?.command(lines)]} machineTitle={ctx.machineTitle} />
		</section>
	);
};

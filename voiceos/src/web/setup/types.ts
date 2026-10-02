// crew's --json shapes as Set up reads them. Each is pinned by a Go-written golden in
// voiceos/testdata/ (the fake crew in test/support serves those same files).

export interface CrewDevServer {
	name: string;
	port?: number;
	command: string;
	dir?: string;
}

export interface CrewBinding {
	var: string;
	value: string;
	server?: string;
}

// crew ls projects --json: the pool, each with its git remote ('' when none).
export interface CrewProject {
	name: string;
	path?: string;
	dev_servers?: CrewDevServer[];
	bindings?: CrewBinding[];
	setup?: string;
	env_cmd?: string;
	remote: string;
}

export interface CrewIssue {
	stage: string;
	project: string;
	server?: string;
	reason?: string;
	detail: string;
}

export interface CrewHealth {
	at: string;
	issues: CrewIssue[];
}

// crew ls worktrees --json: health is a one-line summary, issues what it stands for.
export interface CrewWorktree {
	ref: string;
	path: string;
	dev_running: boolean;
	installing: boolean;
	health?: string;
	issues?: CrewIssue[];
	size_bytes?: number;
}

// One binding between a workspace's members; ok false: its target is not in the workspace.
export interface CrewWire {
	var: string;
	from: string;
	to: string;
	ok: boolean;
}

// crew ls workspaces --json.
export interface CrewWorkspace {
	name: string;
	project_count: number;
	projects?: { name: string; mode: string }[];
	worktrees: string[];
	dev_running: boolean;
	wires?: CrewWire[];
	flat?: boolean;
}

// crew show <ref> --json: one row per member of that worktree.
export interface CrewMember {
	name: string;
	path: string;
	mode: string;
}

export interface CrewStep {
	name: string;
	status: string;
	started_at?: string;
	took_ms?: number;
	detail?: string;
}

export interface CrewProjectStatus {
	project: string;
	state: 'starting' | 'running' | 'ok' | 'failed' | 'interrupted' | string;
	steps: CrewStep[];
	issues: CrewIssue[];
	took_ms?: number;
	at?: string;
}

// crew setup status <ref> --json.
export interface CrewSetupStatus {
	ref: string;
	running: boolean;
	failed: boolean;
	projects: CrewProjectStatus[];
	health: CrewHealth | null;
}

// crew dev status --json: one row per running route.
export interface CrewRoute {
	worktree: string;
	// Absent in a route file written before routes carried their project.
	project?: string;
	server_name: string;
	external_port: number;
	url: string;
}

// crew dev check <ref> --json: what each running server is doing now.
export interface CrewSmoke {
	project: string;
	server: string;
	port: number;
	alive: boolean;
	listening: boolean;
	referenced: boolean;
	tail?: string;
	took_ms: number;
}

// crew env <ref> <project> --json: the effective environment of one project's servers.
export interface CrewEnvRow {
	var: string;
	server: string;
	value: string;
	source: string;
	detail: string;
}

// crew check project <p> --status --json: a check at rest (or running).
export interface CrewCheckStatus {
	project: string;
	state: 'none' | 'running' | 'passed' | 'failed' | string;
	verdict?: string;
	at?: string;
	smoked: boolean;
	health: CrewHealth | null;
	projects: CrewProjectStatus[];
}

// crew rm worktree|workspace … --dry-run --json: what each checkout would lose.
export interface CrewDryRunCheckout {
	ref: string;
	project: string;
	path: string;
	direct: boolean;
	missing: boolean;
	uncommitted: number;
	commits: number;
	size_bytes: number;
}

export interface CrewDryRun {
	checkouts: CrewDryRunCheckout[];
	// The workspace's last worktree: removing it is removing the workspace.
	last: boolean;
}

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/chat"
	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/housekeeping"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/transfer"
	"github.com/FurlanLuka/crew/crew/internal/voice"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// The web's Set up reads every one of these documents; voiceos/testdata is
// where both sides meet (the fake crew in voiceos/test/support builds its
// answers from them). Each is built by the function the command prints, so
// a renamed field fails here first. -update-golden rewrites them.

var goldenAt = time.Date(2026, 10, 2, 9, 30, 0, 0, time.UTC)

func withWorkspacesDir(t *testing.T) {
	t.Helper()
	prev := config.WorkspacesDir
	config.WorkspacesDir = "/w"
	t.Cleanup(func() { config.WorkspacesDir = prev })
}

func goldenPool() []project.Project {
	return []project.Project{
		{Name: "store-front", Path: "/Users/dev/code/store-front", Setup: "pnpm install",
			DevServers: []project.DevServer{{Name: "web", Port: 3000, Command: "pnpm dev"}},
			Bindings:   []project.Binding{{Var: "STORE_API_URL", Value: "{{store-api/api}}"}, {Var: "SIGNALS_URL", Value: "ws://{{signals.host}}/rtc", Server: "web"}}},
		{Name: "store-api", Path: "/Users/dev/.crew/projects/store-api", EnvCmd: "make env",
			DevServers: []project.DevServer{{Name: "api", Port: 4000, Command: "make dev"}, {Name: "worker", Command: "make worker", Dir: "worker"}}},
		{Name: "signals", Path: "/Users/dev/code/signals"},
	}
}

func goldenHealth() *workspace.Health {
	return &workspace.Health{At: goldenAt, Issues: []workspace.Issue{
		{Stage: workspace.StageInstall, Project: "store-api", Detail: "pnpm install:\nERR_PNPM_NO_MATCHING_VERSION"},
		{Stage: workspace.StageSmoke, Project: "store-front", Server: "web", Reason: workspace.ReasonNotListening, Detail: "ready on :3000"},
	}}
}

func TestGoldenLsProjects(t *testing.T) {
	remotes := map[string]string{"store-front": "git@github.com:example/store-front.git", "store-api": "git@github.com:example/store-api.git"}
	checkGolden(t, "ls-projects.json", projectRows(goldenPool(), func(p project.Project) string { return remotes[p.Name] }))
	checkGolden(t, "ls-chats.json", []chat.Chat{
		{ID: "3fa9c1", Dir: "/Users/dev", Name: "research", Created: "2026-10-02T15:00:00Z"},
		{ID: "a0b1c2", Dir: "/Users/dev/notes", Name: "", Created: "2026-10-02T15:05:00Z"},
	})
	checkGolden(t, "chat-add.json", chat.Chat{ID: "3fa9c1", Dir: "/Users/dev", Name: "research", Created: "2026-10-02T15:00:00Z"})
}

func TestGoldenLsWorkspaces(t *testing.T) {
	ws := &workspace.Workspace{Name: "store-front",
		Projects:  []workspace.WorkspaceProject{{Name: "store-front"}, {Name: "store-api"}, {Name: "signals", Mode: workspace.ModeDirect}},
		Worktrees: []workspace.Worktree{{Name: "main"}, {Name: "wrk1"}}}
	lone := &workspace.Workspace{Name: "admin", Projects: []workspace.WorkspaceProject{{Name: "store-front"}}, Worktrees: []workspace.Worktree{{Name: "main"}}}
	running := func(ref workspace.Ref) bool { return ref.Worktree == "main" && ref.Workspace == "store-front" }
	checkGolden(t, "ls-workspaces.json", []workspaceOut{
		workspaceRow(ws, goldenPool(), running),
		workspaceRow(lone, goldenPool(), running),
	})
}

// The rows Set up reads for its board: health, issues and size, and a
// kept check after the workspaces' worktrees.
func TestGoldenLsWorktreesSetup(t *testing.T) {
	withWorkspacesDir(t)
	main := withHealth(worktreeJSONRow(workspace.Ref{Workspace: "store-front", Worktree: "main"}, true, false), nil)
	main.SizeBytes = 1288490188
	wrk1 := withHealth(worktreeJSONRow(workspace.Ref{Workspace: "store-front", Worktree: "wrk1"}, false, false), goldenHealth())
	wrk1.SizeBytes = 734003200
	installing := withHealth(worktreeJSONRow(workspace.Ref{Workspace: "admin", Worktree: "main"}, false, true), nil)
	check := withHealth(worktreeOut{Ref: "check/store-api", Path: "/w/check/store-api"}, &workspace.Health{At: goldenAt, Issues: goldenHealth().Issues[:1]})
	checkGolden(t, "ls-worktrees-setup.json", []worktreeOut{main, wrk1, installing, check})
}

func TestGoldenLsBindings(t *testing.T) {
	p := goldenPool()[0]
	resolved := map[dev.BindingKey]dev.Resolution{
		{Var: "STORE_API_URL"}:              {Var: "STORE_API_URL", Value: "http://localhost:54012", Source: dev.SourceBinding},
		{Var: "SIGNALS_URL", Server: "web"}: {Var: "SIGNALS_URL", Server: "web", Source: dev.SourceUnresolved, Detail: "signals is not in this workspace"},
	}
	checkGolden(t, "ls-bindings.json", bindingRows(p.Bindings, resolved))
}

func TestGoldenLsBindingsPreview(t *testing.T) {
	p := goldenPool()[0]
	previews := map[dev.BindingKey][]workspace.BindingPreview{
		{Var: "STORE_API_URL"}: {
			{Ref: "store-front/main", Value: "http://localhost:54012", Resolved: true, Running: true},
			{Ref: "store-front/wrk1", Value: "http://localhost:54031", Resolved: true},
		},
		{Var: "SIGNALS_URL", Server: "web"}: {
			{Ref: "store-front/main", Detail: "signals has no dev server"},
		},
	}
	checkGolden(t, "ls-bindings-preview.json", previewRows(bindingRows(p.Bindings, nil), previews))
}

func TestGoldenLsOverrides(t *testing.T) {
	res := &workspace.Resolved{Overrides: map[string]string{"STORE_API_URL": "https://dev-api.example.com", "store-api.LOG_LEVEL": "debug"}}
	checkGolden(t, "ls-overrides.json", res.Overrides)
}

func TestGoldenLsBases(t *testing.T) {
	checkGolden(t, "ls-bases.json", baseRows([]workspace.BaseStatus{
		{Project: "store-front", Base: "main", Current: "feature/cart", Behind: 3},
		{Project: "store-api", Base: "main", Current: "main"},
		{Project: "signals", Base: "develop", Current: "develop", Behind: -1, Err: "fetch failed: could not read from remote"},
	}))
	checkGolden(t, "ls-bases-empty.json", baseRows(nil))
}

func TestGoldenScanCheckouts(t *testing.T) {
	checkGolden(t, "scan-checkouts.json", []project.Checkout{
		{Name: "store-front", Path: "/Users/dev/code/store-front", Remote: "git@github.com:example/store-front.git", Known: true},
		{Name: "checkout-api", Path: "/Users/dev/code/acme/checkout-api", Remote: "https://github.com/example/checkout-api.git"},
		{Name: "infra-ops", Path: "/Users/dev/repos/infra-ops", Remote: ""},
	})
}

func TestGoldenAddBindingScan(t *testing.T) {
	proposals := []dev.Proposal{
		{Var: "STORE_API_URL", Value: "http://localhost:4000", Port: 4000, Template: "{{store-api/api}}"},
		{Var: "SIGNALS_URL", Value: "http://localhost:5000", Port: 5000, Template: "{{signals}}"},
		{Var: "ADMIN_URL", Value: "http://localhost:3000", Port: 3000, Ambiguous: true},
	}
	declared := map[string]bool{"STORE_API_URL": true}
	checkGolden(t, "add-binding-scan.json", scanRows(proposals, declared, nil))
	failed := func(p dev.Proposal) error {
		if p.Var == "SIGNALS_URL" {
			return errors.New("no project 'signals' in the pool")
		}
		return nil
	}
	checkGolden(t, "add-binding-scan-apply.json", scanRows(append(proposals, dev.Proposal{Var: "CHECKOUT_URL", Value: "http://localhost:8000", Port: 8000, Template: "{{checkout-api}}"}), declared, failed))
}

func TestGoldenAddBindingDryRun(t *testing.T) {
	b := project.Binding{Var: "API_URL", Value: "{{store-api/api}}", Server: "web"}
	checkGolden(t, "add-binding-dry-run.json", dryRunDoc(b, nil, []workspace.BindingPreview{
		{Ref: "store-front/main", Value: "http://localhost:54012", Resolved: true, Running: true},
		{Ref: "store-front/wrk1", Value: "http://localhost:54031", Resolved: true},
		{Ref: "admin/main", Detail: "store-api is not in this workspace"},
	}))
	bad := project.Binding{Var: "API_URL", Value: "{{store-api.foo}}"}
	checkGolden(t, "add-binding-dry-run-error.json", dryRunDoc(bad, errors.New("{{store-api.foo}}: a server is written {{project/server}}, and .host / .port go after it"), nil))
}

func TestGoldenRmDryRun(t *testing.T) {
	checkGolden(t, "rm-worktree-dry-run.json", workspace.RemovalCost{Last: false, Checkouts: []workspace.CheckoutCost{
		{Ref: "store-front/wrk1", Project: "store-front", Path: "/w/store-front/wrk1/store-front", Uncommitted: 3, Commits: 2, SizeBytes: 524288000},
		{Ref: "store-front/wrk1", Project: "store-api", Path: "/w/store-front/wrk1/store-api", SizeBytes: 209715200},
		{Ref: "store-front/wrk1", Project: "signals", Path: "/Users/dev/code/signals", Direct: true},
	}})
	checkGolden(t, "rm-workspace-project-dry-run.json", workspace.RemovalCost{Checkouts: []workspace.CheckoutCost{
		{Ref: "store-front/main", Project: "store-api", Path: "/w/store-front/main/store-api", Uncommitted: 1, SizeBytes: 104857600},
		{Ref: "store-front/wrk1", Project: "store-api", Path: "/w/store-front/wrk1/store-api", Missing: true},
	}})
	checkGolden(t, "rm-worktree-dry-run-last.json", workspace.RemovalCost{Last: true, Checkouts: []workspace.CheckoutCost{
		{Ref: "admin/main", Project: "store-front", Path: "/w/admin/main/store-front", SizeBytes: 1024},
	}})
}

func TestGoldenSetupStatus(t *testing.T) {
	starting := workspace.Status{Projects: []workspace.ProjectStatus{
		{Project: "store-front", State: workspace.StateRunning, At: goldenAt, Steps: []workspace.RunStep{
			{Name: "checkout", Status: workspace.StepOK, TookMs: 1200},
			{Name: "pnpm install", Status: workspace.StepRunning, StartedAt: goldenAt},
		}},
		{Project: "store-api", State: workspace.StateStarting, At: goldenAt},
	}}
	checkGolden(t, "setup-status-starting.json", jsonStatus(starting, nil))

	failed := workspace.Status{Projects: []workspace.ProjectStatus{
		{Project: "store-front", State: workspace.StateOK, At: goldenAt, TookMs: 42000, Steps: []workspace.RunStep{
			{Name: "checkout", Status: workspace.StepOK, TookMs: 1200},
			{Name: "pnpm install", Status: workspace.StepOK, TookMs: 38000},
			{Name: "smoke web", Status: workspace.StepOK, TookMs: 2800},
		}},
		{Project: "store-api", State: workspace.StateFailed, At: goldenAt, TookMs: 9000, Steps: []workspace.RunStep{
			{Name: "checkout", Status: workspace.StepOK, TookMs: 900},
			{Name: "pnpm install", Status: workspace.StepFailed, TookMs: 8100, Detail: "ERR_PNPM_NO_MATCHING_VERSION"},
		}, Issues: goldenHealth().Issues[:1]},
	}}
	checkGolden(t, "setup-status-failed.json", jsonStatus(failed, &workspace.Health{At: goldenAt, Issues: goldenHealth().Issues[:1]}))

	ok := workspace.Status{Projects: failed.Projects[:1]}
	checkGolden(t, "setup-status-ok.json", jsonStatus(ok, nil))
	checkGolden(t, "setup-status-none.json", jsonStatus(workspace.Status{}, nil))
}

func TestGoldenSetupLogs(t *testing.T) {
	checkGolden(t, "setup-logs.json", logsDoc(workspace.Ref{Workspace: "store-front", Worktree: "wrk1"}, "store-api", "▸ checkout\n✓ checkout 0.9s\n▸ pnpm install\nERR_PNPM_NO_MATCHING_VERSION", 50))
}

// What a tmux pane records around a server: zsh's end-of-line marker, the
// prompt, bracketed paste — the page receives the lines without them.
func TestGoldenDevLogs(t *testing.T) {
	pane := "PORT=3000 pnpm dev\n\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m     \r \r\x1b[0m\x1b[27m\x1b[24m\x1b[J\x1b[35m$\x1b[0m \x1b[?2004hpnpm dev\x1b[?2004l\r\n\x1b[32mready\x1b[0m on http://localhost:3000\n"
	checkGolden(t, "dev-logs.json", devLogsDoc("store-front/main", "web", pane, 0))
}

func TestGoldenCheckStatus(t *testing.T) {
	// A finished runner reports how long it took, a check's as any other's.
	passed := workspace.Status{Projects: []workspace.ProjectStatus{{Project: "store-api", State: workspace.StateOK, At: goldenAt, TookMs: 3000, Steps: []workspace.RunStep{
		{Name: "checkout", Status: workspace.StepOK, TookMs: 900}, {Name: "smoke api", Status: workspace.StepOK, TookMs: 2100}}}}}
	checkGolden(t, "check-status-passed.json", checkStatusDoc("store-api", workspace.CheckInfo{State: workspace.CheckPassed, Status: &passed, At: goldenAt, Smoked: true}))
	checkGolden(t, "check-status-failed.json", checkStatusDoc("store-api", workspace.CheckInfo{State: workspace.CheckFailed, Health: &workspace.Health{At: goldenAt, Issues: goldenHealth().Issues[:1]}, At: goldenAt}))
	checkGolden(t, "check-status-none.json", checkStatusDoc("signals", workspace.CheckInfo{}))
}

func TestGoldenDevStatus(t *testing.T) {
	routes := []dev.WsRoutes{{Slug: "store-front--main", Routes: []dev.Route{
		{Project: "store-front", ServerName: "web", ExternalPort: 3000, InternalPort: 54010, NoProxy: true},
		{Project: "store-api", ServerName: "api", ExternalPort: 4000, InternalPort: 54012, NoProxy: true},
		{Project: "store-api", ServerName: "worker", NoProxy: true},
	}}}
	checkGolden(t, "dev-status.json", dev.StatusRows(routes, "192.168.1.20.nip.io", 80))
}

func TestGoldenDevCheck(t *testing.T) {
	checkGolden(t, "dev-check.json", []workspace.SmokeResult{
		{Project: "store-front", Server: "web", Port: 54010, Alive: true, Listening: true, Referenced: true, TookMs: 2100},
		{Project: "store-api", Server: "api", Port: 54012, Alive: false, Referenced: true, Tail: "Error: Cannot find module 'express'", TookMs: 4000},
		{Project: "store-api", Server: "worker", Alive: true, TookMs: 4000},
	})
}

func TestGoldenEnv(t *testing.T) {
	checkGolden(t, "env.json", envRows([]dev.Resolution{
		{Project: "store-front", Var: "STORE_API_URL", Value: "http://localhost:54012", Source: dev.SourceBinding, Detail: "{{store-api/api}}"},
		{Project: "store-front", Var: "SIGNALS_URL", Server: "web", Source: dev.SourceUnresolved, Detail: "signals is not in this workspace"},
		{Project: "store-front", Var: "LOG_LEVEL", Value: "debug", Source: dev.SourceOverride, Detail: "worktree override"},
	}))
}

// What crew export writes, as the import page reads it: workspaces by their members' names.
func TestGoldenExportBundle(t *testing.T) {
	checkGolden(t, "export-bundle.json", transfer.Bundle{Version: transfer.Version,
		Projects: []transfer.Exported{
			{Project: project.Project{Name: "store-front", Setup: "pnpm install"}, Remote: "git@github.com:example/store-front.git"},
			{Project: project.Project{Name: "store-api"}, Remote: "git@github.com:example/store-api.git"},
			{Project: project.Project{Name: "signals"}},
		},
		Workspaces: []transfer.Membership{
			{Name: "store-front", Projects: []workspace.WorkspaceProject{{Name: "store-front"}, {Name: "store-api"}}},
			{Name: "signals", Projects: []workspace.WorkspaceProject{{Name: "signals", Mode: workspace.ModeDirect}}},
		}})
}

func TestGoldenImportPlan(t *testing.T) {
	b := transfer.Bundle{Version: transfer.Version,
		Projects: []transfer.Exported{
			{Project: project.Project{Name: "store-front"}, Remote: "git@github.com:example/store-front.git"},
			{Project: project.Project{Name: "store-api"}, Remote: "git@github.com:example/store-api.git"},
			{Project: project.Project{Name: "checkout-api"}, Remote: "git@github.com:example/checkout-api.git"},
			{Project: project.Project{Name: "infra-ops"}},
		},
		Workspaces: []transfer.Membership{
			{Name: "store-front", Projects: []workspace.WorkspaceProject{{Name: "store-front"}, {Name: "store-api"}}},
			{Name: "admin", Projects: []workspace.WorkspaceProject{{Name: "checkout-api"}, {Name: "infra-ops"}}},
		}}
	local := project.Project{Name: "store-front", Path: "/Users/dev/code/store-front"}
	plan := transfer.Plan{
		Projects: []transfer.ProjectStatus{
			{Exists: true, Local: &local, LocalRemote: "git@github.com:example/store-front.git"},
			{},
			{Found: "/Users/dev/code/checkout-api"},
			{},
		},
		Workspaces: []transfer.WorkspaceStatus{{}, {}},
		Known:      map[string]bool{"store-front": true},
	}
	prev := config.ProjectsDir
	config.ProjectsDir = "/Users/dev/.crew/projects"
	t.Cleanup(func() { config.ProjectsDir = prev })
	checkGolden(t, "import-plan.json", transfer.PlanRows(b, plan))
}

func TestGoldenCleanDryRun(t *testing.T) {
	checkGolden(t, "clean-dry-run.json", []housekeeping.Action{
		{Kind: housekeeping.KindCheck, Path: "/Users/dev/.crew/checks/store-api.json"},
		{Kind: housekeeping.KindLogs, Path: "/Users/dev/.crew/logs/old-ws--main"},
		{Kind: housekeeping.KindTrash, Path: "/Users/dev/.crew/trash"},
		{Kind: housekeeping.KindPrune, Path: "/Users/dev/.crew/projects/store-api"},
	})
}

func TestGoldenTrash(t *testing.T) {
	checkGolden(t, "trash.json", trashDoc{Path: "/Users/dev/.crew/trash", Bytes: 2147483648, Entries: 3})
	checkGolden(t, "trash-empty.json", emptiedDoc{FreedBytes: 2147483648, Entries: 3})
}

func TestGoldenUpdateCheck(t *testing.T) {
	checkGolden(t, "update-check.json", updateCheck("4.1.0", "4.2.0", nil))
	checkGolden(t, "update.json", updateDoc{From: "4.1.0", To: "4.2.0", Updated: true})
	checkGolden(t, "update-check-offline.json", updateCheck("4.1.0", "", errors.New("could not reach github.com")))
	checkGolden(t, "update-check-dev.json", updateCheck("dev-abc123", "4.2.0", nil))
	checkGolden(t, "update-check-current.json", updateCheck("4.2.0", "4.2.0", nil))
}

func TestGoldenMigrate(t *testing.T) {
	checkGolden(t, "migrate.json", migratedDoc(2))
	checkGolden(t, "migrate-dry-run.json", migrationRows(&workspace.MigrationPlan{Moves: []workspace.MigrationMove{
		{OldWorkspace: "store-front-wrk1", Ref: workspace.Ref{Workspace: "store-front", Worktree: "wrk1"}},
	}}))
}

func TestGoldenConfigShow(t *testing.T) {
	checkGolden(t, "config-show.json", configDoc(config.Settings{ServerIP: "192.168.1.20", SSHHost: "build-box", ProxyPort: 80, Domain: "dev.example.com"}, true))
}

func TestGoldenProxyStatus(t *testing.T) {
	checkGolden(t, "proxy-status.json", dev.ProxyStatus{Running: true, Listening: true, Domain: "192.168.1.20.nip.io", Port: 80, URL: "http://192.168.1.20", HTTPSPort: 443, TLS: "up"})
}

// doctor.json, fix.json and fix-nothing.json are Go-only on purpose: the
// page runs neither command's --json (fix goes as text, --print), so no TS
// reader loads them. They pin the documents agents parse, the shapes the
// skill promises.
func TestGoldenDoctor(t *testing.T) {
	checkGolden(t, "doctor.json", []requirement{
		{Name: "tmux", OK: true, Required: true, Why: "dev servers, setup runners and checks run in tmux", Install: "brew install tmux"},
		{Name: "claude", OK: false, Required: false, Why: "crew claude, crew edit and crew fix open Claude Code", Install: "npm install -g @anthropic-ai/claude-code"},
	})
}

func TestGoldenFix(t *testing.T) {
	checkGolden(t, "fix.json", goldenHealth())
	checkGolden(t, "fix-nothing.json", workspace.Health{Issues: []workspace.Issue{}})
}

func TestGoldenServer(t *testing.T) {
	checkGolden(t, "server-status.json", voice.Status{Running: true, Healthy: true, Port: 7300, PID: 4242,
		LocalhostURL: "http://localhost:7300/login?token=TOKEN", URL: "https://voice--os.192.168.1.20.nip.io/login?token=TOKEN", Secure: true, Binary: "/Users/dev/.crew/bin/voiceos"})
	checkGolden(t, "server-machines.json", machineRows([]voice.MachineRow{
		{Machine: voice.Machine{ID: "vm1", Host: "dev@vm1.example.com", Name: "Build box"}, Status: "connected"},
		{Machine: voice.Machine{ID: "gpu", Host: "gpu", Name: "gpu"}, Status: "unreachable", Detail: "ssh: connect to host gpu port 22: Operation timed out"},
	}))
	checkGolden(t, "server-machines-empty.json", machineRows(nil))
	checkGolden(t, "server-keys.json", []voice.KeyStatus{
		{Name: "anthropic", Set: true, Source: "file", Path: "/Users/dev/.config/crew-voiceos/anthropic.key", Use: "the kernel and the narrator"},
		{Name: "soniox", Set: false, Path: "/Users/dev/.config/crew-voiceos/soniox.key", Use: "speech in and out"},
	})
	checkGolden(t, "server-discord-status.json", voice.DiscordReport{SetUp: true, Token: true,
		Config: &voice.DiscordConfig{Guild: "155", Channel: "226", ChannelName: "Voice OS", GuildName: "Example", Owner: "99", TextChannel: "1001", TextChannelName: "general"},
		Live:   &voice.DiscordLive{Connected: true, OwnerInChannel: false, At: "2026-10-02T09:30:00Z"}})
	checkGolden(t, "server-discord-off.json", voice.DiscordReport{})
	checkGolden(t, "server-discord-setup.json", voice.DiscordConfig{Guild: "155", Channel: "226", ChannelName: "Voice OS", GuildName: "Example", Owner: "99", TextChannel: "1001", TextChannelName: "general"})
	checkGolden(t, "server-discord-channels.json", []voice.DiscordChannelRow{
		{ID: "226", Name: "Voice OS", Kind: "voice", IsVoice: true},
		{ID: "1001", Name: "general", Kind: "text", IsCurrent: true},
	})
	checkGolden(t, "server-keys-set.json", keySavedDoc("soniox", "/Users/dev/.config/crew-voiceos/soniox.key"))
}

// crew-lines.json is what the page shows after a mutation or a refusal:
// crew's own words, from the functions that say them.
func TestGoldenCrewLines(t *testing.T) {
	useTempConfig(t)
	home, _ := os.UserHomeDir()
	ref := workspace.Ref{Workspace: "store-front", Worktree: "wrk1"}
	project.Add(project.Project{Name: "store-api", Path: "/repos/store-api",
		DevServers: []project.DevServer{{Name: "server", Port: 3000, Command: "pnpm dev"}},
		Bindings:   []project.Binding{{Var: "SIGNALS_URL", Value: "{{worktree}}", Server: "server"}}})
	renamed, _ := applyDevAdd("store-api", devAddArgs{name: "api", rename: "server"})
	added, _ := applyDevAdd("store-api", devAddArgs{name: "worker", cmd: "pnpm worker"})
	bundle := transfer.Bundle{Version: transfer.Version, Projects: []transfer.Exported{{Project: project.Project{Name: "infra-ops"}, Remote: "git@github.com:example/infra-ops.git"}}}
	updated, _ := applyProjectUpdate(addProjectArgs{name: "store-api", setup: "pnpm install", hasSetup: true, envCmd: "make env", hasEnvCmd: true})

	lines := map[string]string{
		"pool_removal_trashed":  workspace.PoolRemovalLine(workspace.PoolRemoval{Path: filepath.Join(home, ".crew/projects/store-api"), Clone: workspace.CloneTrashed}),
		"pool_removal_kept":     workspace.PoolRemovalLine(workspace.PoolRemoval{Path: filepath.Join(home, ".crew/projects/store-api"), Clone: workspace.CloneKept}),
		"pool_removal_adopted":  workspace.PoolRemovalLine(workspace.PoolRemoval{Path: filepath.Join(home, "code/signals"), Clone: workspace.CloneUntouched}),
		"pool_removal_refused":  workspace.PoolRemovalAllowed(project.Project{Name: "store-api"}, []string{"store-front"}, false).Error(),
		"setup_running":         workspace.SetupRunningError(ref).Error(),
		"invalid_project_name":  project.ValidateName("Store API").Error(),
		"invalid_worktree_name": workspace.ValidateName("worktree", "wrk--1").Error(),
		"no_dev_server":         errOf(project.FindServer("store-api", project.Get("store-api").DevServers, "web")),
		"key_rejected":          keyRejectedLine("soniox"),
		"dev_server_renamed":    renamed,
		"dev_server_added":      added,
		"project_updated":       strings.Join(updated, "\n"),
		"rename_warning":        transfer.RenameWarning(transfer.Bundle{Projects: []transfer.Exported{{Project: project.Project{Name: "store-front", Bindings: []project.Binding{{Var: "STORE_API_URL", Value: "{{store-api}}"}}}}}}, "store-api", "shop-api"),
		"still_bound":           "Removed binding SIGNALS_URL from store-api" + stillBoundNote([]project.Binding{{Var: "SIGNALS_URL"}, {Var: "SIGNALS_URL", Server: "api"}}, "SIGNALS_URL", "api"),
		"remote_machine":        remoteMachineLine,
		"cli_fallback":          cliFallbackLine,
		"configure_in_browser":  configureInBrowser,
		"voice_alias_note":      aliasNote,
		"update_available":      updateCheckLine(updateCheck("4.1.0", "4.2.0", nil)),
		"update_dev":            updateCheckLine(updateCheck("dev-abc123", "4.2.0", nil)),
		"update_current":        updateCheckLine(updateCheck("4.2.0", "4.2.0", nil)),
		"update_offline":        updateCheckLine(updateCheck("4.1.0", "", errors.New("could not reach github.com"))),
		"check_passed":          workspace.CheckPassedLine("store-api"),
		"health_warning":        strings.TrimSuffix(healthWarningLine(&workspace.Resolved{Ref: ref, Health: goldenHealth()}), "\n"),
		"fix_hint":              fixHint(ref),
		"started":               renderStarted(ref, "Created store-front/wrk1", 2, "", "http://localhost:7300/"),
		"import_collision":      errOf(transfer.ApplyProject(bundle, transfer.Inspect(bundle), "infra-ops", transfer.ProjectOptions{Name: "store-api"})),
		"restart_not_running":   workspace.RestartRefusal(ref, dev.ErrNotRunning).Error(),
		"restart_before_66":     workspace.RestartRefusal(ref, dev.ErrStartedBefore66).Error(),
		"restart_not_in_set":    workspace.RestartRefusal(ref, dev.NotInRunningSetError{Server: "store-api/docs"}).Error(),
		"plugin_missing":        pluginLine(pluginMissing, ""),
		"plugin_old":            pluginLine(pluginOld, "6.0.0"),
		"claude_old":            pluginLine(claudeOld, "2.1.282"),
		"server_ambiguous":      errOf(dev.ResolveServerName([]dev.DevProject{{Name: "store-api", DevServers: []dev.DevServerConfig{{Name: "web"}}}, {Name: "store-front", DevServers: []dev.DevServerConfig{{Name: "web"}}}}, "web")),
	}
	checkGolden(t, "crew-lines.json", lines)
}

func errOf[T any](_ T, err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

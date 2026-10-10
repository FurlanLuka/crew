package workspace

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/dev"
	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

func desktopResolved(dir string, projects ...ResolvedProject) *Resolved {
	ref := Ref{Workspace: "store", Worktree: "main"}
	return &Resolved{Ref: ref, Slug: ref.Slug(), Dir: dir, Projects: projects, Ports: map[string]int{}}
}

func TestDesktopFolder(t *testing.T) {
	one := desktopResolved("/w/store/main", ResolvedProject{Name: "store-api", Path: "/w/store/main/store-api"})
	if got := DesktopFolder(one); got != "/w/store/main/store-api" {
		t.Errorf("one project → %q, want its checkout", got)
	}
	two := desktopResolved("/w/store/main", ResolvedProject{Name: "store-api", Path: "/w/store/main/store-api"}, ResolvedProject{Name: "infra-ops", Path: "/repos/infra-ops", Direct: true})
	if got := DesktopFolder(two); got != "/w/store/main" {
		t.Errorf("two projects → %q, want the worktree root", got)
	}
}

func TestLaunchServersAndConfig(t *testing.T) {
	res := desktopResolved("/w/store/main",
		ResolvedProject{Name: "store-front", DevServers: []project.DevServer{{Name: "web", Port: 3000}}},
		ResolvedProject{Name: "store-api", DevServers: []project.DevServer{{Name: "api", Port: 4000}, {Name: "worker"}, {Name: "docs", Port: 4100}}},
	)
	res.Ports = map[string]int{"store-front/web": 54010, "store-api/api": 54012}
	routes := []dev.Route{{Project: "store-api", ServerName: "api", InternalPort: 54099}}

	servers := LaunchServers(res, routes)
	want := []LaunchServer{{"store-front/web", 54010}, {"store-api/api", 54099}}
	if len(servers) != 2 || servers[0] != want[0] || servers[1] != want[1] {
		t.Fatalf("servers = %+v, want %+v (running port wins, no worker, docs has no port yet)", servers, want)
	}

	got := string(LaunchConfig(servers))
	wantDoc := launchMarker + `
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "store-front/web",
      "url": "http://localhost:54010"
    },
    {
      "name": "store-api/api",
      "url": "http://localhost:54099"
    }
  ]
}
`
	if got != wantDoc {
		t.Errorf("launch.json =\n%s\nwant\n%s", got, wantDoc)
	}
	if LaunchConfig(nil) != nil {
		t.Error("no servers → nothing to write")
	}
}

func TestLaunchConfigWritable(t *testing.T) {
	if !launchConfigWritable(nil, false) {
		t.Error("absent → writable")
	}
	if !launchConfigWritable([]byte(launchMarker+"\n{}"), true) {
		t.Error("crew's own → writable")
	}
	if launchConfigWritable([]byte(`{"version":"0.0.1"}`), true) {
		t.Error("someone else's → left alone")
	}
}

// In a single project's checkout the file goes into its .claude/ and the
// repo's info/exclude, so git status stays clean; a refresh never creates
// one; someone else's file is never touched.
func TestWriteLaunchConfig(t *testing.T) {
	setupTestConfig(t)
	checkout := filepath.Join(t.TempDir(), "store-api")
	os.MkdirAll(checkout, 0o755)
	initRepo(t, checkout)
	res := desktopResolved(filepath.Dir(checkout), ResolvedProject{Name: "store-api", Path: checkout, DevServers: []project.DevServer{{Name: "api", Port: 4000}}})
	res.Ports = map[string]int{"store-api/api": 54012}
	path := filepath.Join(checkout, ".claude", "launch.json")

	if err := RefreshLaunchConfig(res); err != nil {
		t.Fatalf("refresh = %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("a refresh must not create launch.json")
	}

	if warn, err := WriteLaunchConfig(res); err != nil || warn != "" {
		t.Fatalf("write = %q, %v", warn, err)
	}
	data, _ := os.ReadFile(path)
	if !strings.Contains(string(data), `"url": "http://localhost:54012"`) {
		t.Errorf("launch.json:\n%s", data)
	}
	status, _ := exec.Command("git", "-C", checkout, "status", "--porcelain").Output()
	if strings.TrimSpace(string(status)) != "" {
		t.Errorf("git status should be clean, got:\n%s", status)
	}
	WriteLaunchConfig(res)
	exclude, _ := os.ReadFile(filepath.Join(checkout, ".git", "info", "exclude"))
	if strings.Count(string(exclude), ".claude/launch.json") != 1 {
		t.Errorf("exclude should name it once:\n%s", exclude)
	}

	res.Ports["store-api/api"] = 54013
	RefreshLaunchConfig(res)
	data, _ = os.ReadFile(path)
	if !strings.Contains(string(data), "54013") {
		t.Error("a refresh rewrites crew's own file with the new port")
	}

	os.WriteFile(path, []byte(`{"version":"0.0.1","configurations":[]}`), 0o644)
	warn, _ := WriteLaunchConfig(res)
	if !strings.Contains(warn, "is not crew's") {
		t.Errorf("someone else's file → warning, got %q", warn)
	}
	if data, _ := os.ReadFile(path); !strings.HasPrefix(string(data), `{"version"`) {
		t.Error("someone else's file must stay as it was")
	}
}

// crew's checkouts are linked git worktrees: the entry goes to the common
// info/exclude. A multi-project root is no repo, and no exclude is touched
// — git would otherwise walk up to whatever repo is above it.
func TestWriteLaunchConfig_LinkedWorktreeAndRoot(t *testing.T) {
	setupTestConfig(t)
	base := filepath.Join(t.TempDir(), "store-api")
	os.MkdirAll(base, 0o755)
	initRepo(t, base)
	root := t.TempDir()
	checkout := filepath.Join(root, "store-api")
	if out, err := exec.Command("git", "-C", base, "worktree", "add", "-q", checkout).CombinedOutput(); err != nil {
		t.Fatalf("git worktree add: %v %s", err, out)
	}
	res := desktopResolved(root, ResolvedProject{Name: "store-api", Path: checkout, DevServers: []project.DevServer{{Name: "api", Port: 4000}}})
	res.Ports = map[string]int{"store-api/api": 54012}
	if _, err := WriteLaunchConfig(res); err != nil {
		t.Fatal(err)
	}
	if status, _ := exec.Command("git", "-C", checkout, "status", "--porcelain").Output(); strings.TrimSpace(string(status)) != "" {
		t.Errorf("linked worktree status should be clean:\n%s", status)
	}

	// A root that sits inside some repo — the walk-up case.
	outer := t.TempDir()
	initRepo(t, outer)
	multiRoot := filepath.Join(outer, "wt")
	os.MkdirAll(multiRoot, 0o755)
	multi := desktopResolved(multiRoot,
		ResolvedProject{Name: "store-api", Path: filepath.Join(multiRoot, "store-api"), DevServers: []project.DevServer{{Name: "api", Port: 4000}}},
		ResolvedProject{Name: "store-front", Path: filepath.Join(multiRoot, "store-front")})
	multi.Ports = map[string]int{"store-api/api": 54012}
	if _, err := WriteLaunchConfig(multi); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(multiRoot, ".claude", "launch.json")); err != nil {
		t.Errorf("the root gets its launch.json: %v", err)
	}
	if data, _ := os.ReadFile(filepath.Join(outer, ".git", "info", "exclude")); strings.Contains(string(data), "launch.json") {
		t.Error("a repo above the root must not have its exclude touched")
	}
}

func TestDesktopCommand(t *testing.T) {
	got := DesktopCommand("/opt/claude bin/claude", "/Users/dev", "")
	if got != "env -u CREW_REF HOME='/Users/dev' '/opt/claude bin/claude' --desktop" {
		t.Errorf("command = %s", got)
	}
	got = DesktopCommand("/usr/local/bin/claude", "/Users/dev", "/Users/dev/.claude-work")
	if got != "env -u CREW_REF HOME='/Users/dev' CLAUDE_CONFIG_DIR='/Users/dev/.claude-work' '/usr/local/bin/claude' --desktop" {
		t.Errorf("command with a config dir = %s", got)
	}
}

// The line runs under the tmux server, whose environment is not ours: HOME
// and the binary's path must reach the process as written.
func TestDesktopCommand_RunsUnderTmux(t *testing.T) {
	if !crewExec.HasTmux() {
		t.Skip("tmux not available")
	}
	dir := t.TempDir()
	marker := filepath.Join(dir, "ran")
	stub := filepath.Join(dir, "claude")
	os.WriteFile(stub, []byte("#!/bin/sh\necho \"$HOME $PWD ${CREW_REF:-unset} $*\" > '"+marker+"'\n"), 0o755)
	session := "crew-desktop-test-" + filepath.Base(dir)
	t.Cleanup(func() { crewExec.KillTmuxSession(session) })

	if err := crewExec.TmuxRunInSession(session, "store--main", dir, DesktopCommand(stub, "/tmp/fakehome", "")); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(marker); err == nil {
			// The folder tmux starts in is the folder Desktop opens.
			if want := "/tmp/fakehome " + realPath(dir) + " unset --desktop"; strings.TrimSpace(string(data)) != want && strings.TrimSpace(string(data)) != "/tmp/fakehome "+dir+" unset --desktop" {
				t.Errorf("claude ran with %q", data)
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("the stub claude never ran")
}

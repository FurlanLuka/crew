package main

import (
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/voice"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

var updateGolden = flag.Bool("update-golden", false, "rewrite voiceos/testdata from crew's own JSON shapes")

// Voice OS parses `crew ls worktrees --json` and `crew show <ref> --json`.
// These goldens are the contract: crew writes them here, the TypeScript
// adapter spec parses the same files, so a renamed field fails one side.
func checkGolden(t *testing.T, name string, v any) {
	t.Helper()
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	data = append(data, '\n')
	path := filepath.Join("..", "voiceos", "testdata", name)
	if *updateGolden {
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v (run go test -run Golden -update-golden)", path, err)
	}
	if string(want) != string(data) {
		t.Errorf("%s drifted from crew's JSON shape.\nwant:\n%s\ngot:\n%s", name, want, data)
	}
}

// Rows come from the same functions the commands print, not hand-built structs.
func TestVoiceGoldenLsWorktrees(t *testing.T) {
	prev := config.WorkspacesDir
	config.WorkspacesDir = "/w"
	t.Cleanup(func() { config.WorkspacesDir = prev })

	checkGolden(t, "ls-worktrees.json", []worktreeOut{
		worktreeJSONRow(workspace.Ref{Workspace: "store-front", Worktree: "main"}, true, false),
		worktreeJSONRow(workspace.Ref{Workspace: "store-front", Worktree: "wrk1"}, false, false),
		worktreeJSONRow(workspace.Ref{Workspace: "check", Worktree: "checkout-api"}, false, false),
	})
}

func TestVoiceGoldenShow(t *testing.T) {
	res := &workspace.Resolved{Projects: []workspace.ResolvedProject{
		{Name: "store-api", Path: "/w/store-front/main/store-api"},
		{Name: "checkout-api", Path: "/w/store-front/main/checkout-api"},
	}}
	checkGolden(t, "show-worktree.json", showRows(res))
}

func TestRestartCommand_RunsDetached(t *testing.T) {
	cmd := restartCommand("/usr/local/bin/crew")

	if got := strings.Join(cmd.Args, " "); got != "/usr/local/bin/crew voice _restart" {
		t.Fatalf("args: %q", got)
	}
	// Its own session: stopping Voice OS kills the session a restart is usually
	// asked from, and the helper must outlive it to start Voice OS again.
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.Setsid {
		t.Fatal("the restart helper is not detached")
	}
}

func TestBrowserOpener(t *testing.T) {
	cases := map[string]string{"darwin": "open", "linux": "xdg-open"}
	for goos, want := range cases {
		if got := browserOpener(goos); got != want {
			t.Errorf("browserOpener(%q) = %q, want %q", goos, got, want)
		}
	}
}

func TestParseDiscordSetupArgs(t *testing.T) {
	opts, err := parseDiscordSetupArgs([]string{"--guild=155", "--channel=Voice OS", "--user=226"})
	if err != nil {
		t.Fatal(err)
	}
	if opts.Guild != "155" || opts.Channel != "Voice OS" || opts.User != "226" {
		t.Errorf("opts %+v", opts)
	}
	if _, err := parseDiscordSetupArgs([]string{"--token=x"}); err == nil {
		t.Error("an unknown flag was accepted")
	}
}

func TestChooseDiscordToken(t *testing.T) {
	cases := []struct {
		name, entered, saved, want string
		ok                         bool
	}{
		{"entered wins", "  new-token\n", "old-token", "new-token", true},
		{"entered with nothing saved", "new-token", "", "new-token", true},
		{"blank keeps saved", " \n", "old-token", "old-token", true},
		{"empty keeps saved", "", "old-token", "old-token", true},
		{"both blank", " \n", "", "", false},
	}
	for _, c := range cases {
		got, ok := chooseDiscordToken(c.entered, c.saved)
		if got != c.want || ok != c.ok {
			t.Errorf("%s: chooseDiscordToken(%q, %q) = %q, %v; want %q, %v", c.name, c.entered, c.saved, got, ok, c.want, c.ok)
		}
	}
}

// A browser opens only for a person at this machine's screen.
func TestShouldOpenBrowser(t *testing.T) {
	mac := openEnv{Requested: true, StdoutTTY: true, GOOS: "darwin"}
	cases := []struct {
		name string
		env  func(openEnv) openEnv
		want bool
	}{
		{"a terminal on a Mac", func(e openEnv) openEnv { return e }, true},
		{"no terminal", func(e openEnv) openEnv { e.StdoutTTY = false; return e }, false},
		{"--json", func(e openEnv) openEnv { e.JSON = true; return e }, false},
		{"--no-open", func(e openEnv) openEnv { e.Requested = false; return e }, false},
		{"over SSH", func(e openEnv) openEnv { e.SSH = true; return e }, false},
		{"linux, no display", func(e openEnv) openEnv { e.GOOS = "linux"; return e }, false},
		{"linux with X11 or Wayland", func(e openEnv) openEnv { e.GOOS = "linux"; e.Display = true; return e }, true},
		{"linux display over SSH", func(e openEnv) openEnv { e.GOOS = "linux"; e.Display = true; e.SSH = true; return e }, false},
	}
	for _, c := range cases {
		if got := shouldOpenBrowser(c.env(mac)); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}

// Bare crew needs tmux and nothing else: a missing claude is the page's to
// say, when a session cannot start.
func TestBareRequirements(t *testing.T) {
	both := []voice.Requirement{{Name: "tmux"}, {Name: "claude"}}
	if got := bareRequirements(both); len(got) != 1 || got[0].Name != "tmux" {
		t.Errorf("bare = %+v", got)
	}
	if got := bareRequirements([]voice.Requirement{{Name: "claude"}}); len(got) != 0 {
		t.Errorf("claude alone must not stop bare crew: %+v", got)
	}
}

// Over SSH the localhost link is the wrong machine's: the proxy link whenever
// the proxy reaches the server (a domain set or the automatic nip.io one),
// the tunnel otherwise.
func TestServerLinkLines(t *testing.T) {
	st := voice.Status{Port: 7300, LocalhostURL: "http://localhost:7300/login?token=T", URL: "https://voice--os.dev.example.com/login?token=T"}
	if got := strings.Join(serverLinkLines(st, false, true, "box"), "\n"); got != "crew is running: http://localhost:7300/login?token=T" {
		t.Errorf("local: %q", got)
	}
	if got := strings.Join(serverLinkLines(st, true, true, "box"), "\n"); got != "crew is running: https://voice--os.dev.example.com/login?token=T" {
		t.Errorf("ssh, the proxy reaches it: %q", got)
	}
	want := "crew is running on this machine, port 7300. From your computer:\n  ssh -L 7300:localhost:7300 box\nthen open http://localhost:7300/login?token=T"
	if got := strings.Join(serverLinkLines(st, true, false, "box"), "\n"); got != want {
		t.Errorf("ssh, the proxy does not reach it:\n%s\nwant\n%s", got, want)
	}
	if got := serverLinkLines(st, true, false, ""); !strings.Contains(got[1], "ssh -L 7300:localhost:7300 <this machine>") {
		t.Errorf("no ssh_host: %q", got[1])
	}
}

// The alias note is for a person: never on a pipe, never for the hidden
// forms another process runs (voice _attach's stdout is the link alone).
func TestShowAliasNote(t *testing.T) {
	for _, tt := range []struct {
		tty  bool
		args []string
		want bool
	}{
		{true, nil, true},
		{true, []string{"status"}, true},
		{false, []string{"status"}, false},
		{true, []string{"_attach"}, false},
		{true, []string{"_restart"}, false},
		{false, []string{"machines", "ls"}, false},
	} {
		if got := showAliasNote(tt.tty, tt.args); got != tt.want {
			t.Errorf("showAliasNote(%v, %v) = %v", tt.tty, tt.args, got)
		}
	}
}

// Bare crew server is its status; bare crew voice still starts it, as it
// always did; flags alone keep the bare meaning.
func TestServerSub(t *testing.T) {
	for _, tt := range []struct {
		args       []string
		bare, want string
		rest       int
	}{
		{nil, "status", "status", 0},
		{nil, "start", "start", 0},
		{[]string{"--no-open"}, "start", "start", 1},
		{[]string{"stop"}, "start", "stop", 0},
		{[]string{"keys", "set", "soniox"}, "status", "keys", 2},
		{[]string{"_attach"}, "start", "_attach", 0},
	} {
		sub, rest := serverSub(tt.args, tt.bare)
		if sub != tt.want || len(rest) != tt.rest {
			t.Errorf("serverSub(%v, %s) = %s %v", tt.args, tt.bare, sub, rest)
		}
	}
}

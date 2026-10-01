package main

import (
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
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

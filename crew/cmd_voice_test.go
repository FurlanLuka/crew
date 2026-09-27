package main

import (
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
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

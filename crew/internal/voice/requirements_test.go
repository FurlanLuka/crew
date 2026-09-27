package voice

import (
	"os"
	"path/filepath"
	"testing"
)

func unmetNames(t *testing.T) []string {
	t.Helper()
	var names []string
	for _, req := range UnmetRequirements() {
		if req.Install == "" || req.Why == "" {
			t.Errorf("%s has no why or install line", req.Name)
		}
		names = append(names, req.Name)
	}
	return names
}

func fakeExecutable(t *testing.T, dir, name string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestRequirements_NothingOnPath(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	t.Setenv("VOICEOS_CLAUDE_BIN", "")

	got := unmetNames(t)

	if len(got) != 2 || got[0] != "tmux" || got[1] != "claude" {
		t.Errorf("unmet = %v, want [tmux claude]", got)
	}
}

func TestRequirements_AllThere(t *testing.T) {
	dir := t.TempDir()
	fakeExecutable(t, dir, "tmux")
	fakeExecutable(t, dir, "claude")
	t.Setenv("PATH", dir)
	t.Setenv("VOICEOS_CLAUDE_BIN", "")

	if got := unmetNames(t); len(got) != 0 {
		t.Errorf("unmet = %v, want none", got)
	}
}

func TestRequirements_ClaudeOverride(t *testing.T) {
	dir := t.TempDir()
	fakeExecutable(t, dir, "tmux")
	t.Setenv("PATH", dir)

	t.Setenv("VOICEOS_CLAUDE_BIN", fakeExecutable(t, t.TempDir(), "my-claude"))
	if got := unmetNames(t); len(got) != 0 {
		t.Errorf("with an existing override, unmet = %v", got)
	}

	// Voice OS runs the override and never falls back to PATH, so a claude on
	// PATH does not make a broken override fine.
	fakeExecutable(t, dir, "claude")
	t.Setenv("VOICEOS_CLAUDE_BIN", filepath.Join(dir, "missing-claude"))
	if got := unmetNames(t); len(got) != 1 || got[0] != "claude" {
		t.Errorf("with an override that does not exist, unmet = %v, want [claude]", got)
	}
}

func TestClaudeBin_ResolvedForVoiceOS(t *testing.T) {
	dir := t.TempDir()
	onPath := fakeExecutable(t, dir, "claude")
	t.Setenv("PATH", dir)
	t.Setenv("VOICEOS_CLAUDE_BIN", "")

	if got := ClaudeBin(); got != onPath {
		t.Errorf("ClaudeBin = %q, want the one on PATH %q", got, onPath)
	}

	overrideDir := t.TempDir()
	override := fakeExecutable(t, overrideDir, "my-claude")
	t.Setenv("VOICEOS_CLAUDE_BIN", override)
	if got := ClaudeBin(); got != override {
		t.Errorf("ClaudeBin = %q, want the override %q", got, override)
	}

	// Relative to where crew was run, not to where tmux starts Voice OS.
	t.Chdir(overrideDir)
	t.Setenv("VOICEOS_CLAUDE_BIN", "my-claude")
	resolved, _ := filepath.EvalSymlinks(ClaudeBin())
	wanted, _ := filepath.EvalSymlinks(override)
	if resolved != wanted {
		t.Errorf("relative override resolved to %q, want %q", resolved, wanted)
	}
}

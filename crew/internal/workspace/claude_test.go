package workspace

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// pinClaudeConfig fixes config.UserSetClaudeConfig for the duration of a test.
// It is a package global seeded from $CLAUDE_CONFIG_DIR at process start, so
// leaving it alone would make exact command assertions pass in a clean
// environment and fail for anyone running with that variable set.
func pinClaudeConfig(t *testing.T, userSet bool) {
	t.Helper()
	prev := config.UserSetClaudeConfig
	config.UserSetClaudeConfig = userSet
	t.Cleanup(func() { config.UserSetClaudeConfig = prev })
}

func newTestWorkspace(t *testing.T, name string, projects []WorkspaceProject) *Resolved {
	t.Helper()
	tmp := setupTestConfig(t)
	for _, wp := range projects {
		project.Add(project.Project{Name: wp.Name, Path: filepath.Join(tmp, wp.Name)})
	}
	ws := &Workspace{Name: name, Projects: projects}
	if err := Save(ws); err != nil {
		t.Fatalf("Save: %v", err)
	}
	res, err := Resolve(Ref{Workspace: name})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	return res
}

func TestBuildClaudeParts_SingleProject(t *testing.T) {
	pinClaudeConfig(t, false)
	res := newTestWorkspace(t, "solo", []WorkspaceProject{{Name: "api", Role: "backend"}})

	parts, workDir := buildClaudeParts(res)

	got := strings.Join(parts, " ")
	want := "IS_SANDBOX=1 claude --dangerously-skip-permissions"
	if got != want {
		t.Errorf("command = %q, want %q", got, want)
	}

	// A single-project workspace must start in the project itself, not the
	// workspace root — that root is empty for a direct-mode project.
	if wantDir := WorktreePath(Ref{Workspace: "solo"}, "api"); workDir != wantDir {
		t.Errorf("workDir = %q, want %q", workDir, wantDir)
	}
}

func TestBuildClaudeParts_MultiProject(t *testing.T) {
	pinClaudeConfig(t, false)
	res := newTestWorkspace(t, "multi", []WorkspaceProject{
		{Name: "api", Role: "backend"},
		{Name: "web", Role: "frontend"},
	})

	parts, workDir := buildClaudeParts(res)

	got := strings.Join(parts, " ")
	want := "IS_SANDBOX=1 claude --dangerously-skip-permissions" +
		" --add-dir '" + WorktreePath(Ref{Workspace: "multi"}, "api") + "'" +
		" --add-dir '" + WorktreePath(Ref{Workspace: "multi"}, "web") + "'" +
		" -- \"$(cat '" + PromptFilePath(Ref{Workspace: "multi"}) + "')\""
	if got != want {
		t.Errorf("command =\n%q\nwant\n%q", got, want)
	}

	if workDir != WorktreeDir(Ref{Workspace: "multi"}) {
		t.Errorf("workDir = %q, want %q", workDir, WorktreeDir(Ref{Workspace: "multi"}))
	}
}

func TestBuildClaudeParts_ClaudeConfigDir(t *testing.T) {
	pinClaudeConfig(t, true)
	res := newTestWorkspace(t, "solo", []WorkspaceProject{{Name: "api", Role: "backend"}})

	parts, _ := buildClaudeParts(res)

	got := strings.Join(parts, " ")
	want := "IS_SANDBOX=1 CLAUDE_CONFIG_DIR='" + config.ClaudeConfigDir +
		"' claude --dangerously-skip-permissions"
	if got != want {
		t.Errorf("command = %q, want %q", got, want)
	}
}

// A lone direct-mode project is Claude pointed straight at the user's real
// repository with permissions skipped, so it must still get the orientation
// prompt carrying the CAUTION framing.
func TestBuildClaudeParts_SingleDirectProjectStillGetsPrompt(t *testing.T) {
	pinClaudeConfig(t, false)
	res := newTestWorkspace(t, "solo", []WorkspaceProject{
		{Name: "api", Role: "backend", Mode: ModeDirect},
	})

	parts, _ := buildClaudeParts(res)

	got := strings.Join(parts, " ")
	if !strings.Contains(got, "$(cat '"+PromptFilePath(Ref{Workspace: "solo"})+"')") {
		t.Errorf("single direct project must inject the prompt, got: %s", got)
	}
	// It is a single project, so no --add-dir is needed.
	if strings.Contains(got, "--add-dir") {
		t.Errorf("single project should not pass --add-dir, got: %s", got)
	}
}

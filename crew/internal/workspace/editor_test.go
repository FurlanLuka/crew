package workspace

import (
	"reflect"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
)

func TestClaudeTaskFor_SingleProject(t *testing.T) {
	pinClaudeConfig(t, false)
	res := newTestWorkspace(t, "solo", []WorkspaceProject{{Name: "api", Role: "backend"}})

	task := ClaudeTaskFor(res)

	// A single-project workspace opens in the project itself. The workspace
	// root is an empty scratch dir for a direct-mode project.
	if want := res.Projects[0].Path; task.LeadPath != want {
		t.Errorf("LeadPath = %q, want %q", task.LeadPath, want)
	}
	if task.AddDirs != nil {
		t.Errorf("AddDirs = %v, want nil", task.AddDirs)
	}
	if task.PromptFile != "" {
		t.Errorf("PromptFile = %q, want empty", task.PromptFile)
	}
	if !task.SkipPermissions {
		t.Error("SkipPermissions should be true — both launch modes skip")
	}
}

func TestClaudeTaskFor_MultiProject(t *testing.T) {
	pinClaudeConfig(t, false)
	res := newTestWorkspace(t, "multi", []WorkspaceProject{
		{Name: "api", Role: "backend"},
		{Name: "web", Role: "frontend"},
	})

	task := ClaudeTaskFor(res)

	if task.LeadPath != WorktreeDir(Ref{Workspace: "multi"}) {
		t.Errorf("LeadPath = %q, want %q", task.LeadPath, WorktreeDir(Ref{Workspace: "multi"}))
	}
	// Every project is exposed, the lead included — the agent-teams path used
	// to skip the lead, and the two modes must not drift apart again.
	want := []string{WorktreePath(Ref{Workspace: "multi"}, "api"), WorktreePath(Ref{Workspace: "multi"}, "web")}
	if !reflect.DeepEqual(task.AddDirs, want) {
		t.Errorf("AddDirs = %v, want %v", task.AddDirs, want)
	}
	if task.PromptFile != PromptFilePath(Ref{Workspace: "multi"}) {
		t.Errorf("PromptFile = %q, want %q", task.PromptFile, PromptFilePath(Ref{Workspace: "multi"}))
	}
}

func TestClaudeTaskFor_SingleDirectProjectStillGetsPrompt(t *testing.T) {
	pinClaudeConfig(t, false)
	res := newTestWorkspace(t, "solo", []WorkspaceProject{
		{Name: "api", Role: "backend", Mode: ModeDirect},
	})

	if task := ClaudeTaskFor(res); task.PromptFile != PromptFilePath(Ref{Workspace: "solo"}) {
		t.Errorf("PromptFile = %q, want the prompt so the CAUTION framing reaches Claude", task.PromptFile)
	}
}

func TestClaudeTaskFor_ClaudeConfigDir(t *testing.T) {
	pinClaudeConfig(t, true)
	res := newTestWorkspace(t, "solo", []WorkspaceProject{{Name: "api", Role: "backend"}})

	if task := ClaudeTaskFor(res); task.ClaudeConfigDir != config.ClaudeConfigDir {
		t.Errorf("ClaudeConfigDir = %q, want %q", task.ClaudeConfigDir, config.ClaudeConfigDir)
	}

	pinClaudeConfig(t, false)
	if task := ClaudeTaskFor(res); task.ClaudeConfigDir != "" {
		t.Errorf("ClaudeConfigDir = %q, want empty when unset", task.ClaudeConfigDir)
	}
}

// The editor and terminal launch modes build the same launch independently.
// This is the cross-check that stops them drifting.
func TestClaudeTaskFor_AgreesWithBuildClaudeParts(t *testing.T) {
	pinClaudeConfig(t, false)

	for _, projects := range [][]WorkspaceProject{
		{{Name: "api", Role: "backend"}},
		{{Name: "api", Role: "backend", Mode: ModeDirect}},
		{{Name: "api", Role: "backend"}, {Name: "web", Role: "frontend"}},
	} {
		res := newTestWorkspace(t, "ws", projects)

		task := ClaudeTaskFor(res)
		parts, workDir := buildClaudeParts(res)
		cmd := strings.Join(parts, " ")

		if task.LeadPath != workDir {
			t.Errorf("%d project(s): editor LeadPath %q != terminal workDir %q",
				len(projects), task.LeadPath, workDir)
		}
		for _, dir := range task.AddDirs {
			if !strings.Contains(cmd, "--add-dir '"+dir+"'") {
				t.Errorf("%d project(s): editor exposes %q but terminal command does not: %s",
					len(projects), dir, cmd)
			}
		}
		if (task.PromptFile != "") != strings.Contains(cmd, "$(cat ") {
			t.Errorf("%d project(s): modes disagree on injecting the prompt (editor=%q, terminal=%s)",
				len(projects), task.PromptFile, cmd)
		}
	}
}

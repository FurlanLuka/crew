package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/project"
)

func TestDirectRefusal(t *testing.T) {
	owners := map[string]string{"api": "ops"}
	for _, tt := range []struct {
		name      string
		proj, ws  string
		worktrees int
		repoErr   error
		want      string
	}{
		{"held elsewhere", "api", "feature", 1, nil, "already attached to workspace 'ops' in direct mode"},
		{"held by this workspace", "api", "ops", 1, nil, ""},
		{"too many worktrees", "web", "feature", 2, nil, "has 2 worktrees, so 'web' cannot be added in direct mode"},
		{"a wizard's workspace has none yet", "web", "new", 0, nil, ""},
		{"not a repo", "web", "feature", 1, errors.New("path /x is not a git repository"), "project 'web' cannot be used in direct mode: path /x is not a git repository"},
		{"fine", "web", "feature", 1, nil, ""},
	} {
		got := directRefusal(tt.proj, tt.ws, owners, tt.worktrees, tt.repoErr)
		if !strings.Contains(got, tt.want) || (tt.want == "" && got != "") {
			t.Errorf("%s: %q, want %q", tt.name, got, tt.want)
		}
	}
}

// DirectRefusals reads the other workspaces and each project's repo once.
func TestDirectRefusals(t *testing.T) {
	tmp := setupTestConfig(t)
	repo := filepath.Join(tmp, "repos", "api")
	os.MkdirAll(repo, 0o755)
	initRepo(t, repo)
	pool := []project.Project{
		{Name: "api", Path: repo},
		{Name: "docs", Path: filepath.Join(tmp, "nowhere")},
	}
	Save(&Workspace{Name: "ops", Projects: []WorkspaceProject{{Name: "api", Mode: ModeDirect}}, Worktrees: []Worktree{{Name: "main"}}})

	got := DirectRefusals(&Workspace{Name: "feature"}, pool)
	if !strings.Contains(got["api"], "workspace 'ops'") {
		t.Errorf("api: %q", got["api"])
	}
	if !strings.Contains(got["docs"], "cannot be used in direct mode") {
		t.Errorf("docs: %q", got["docs"])
	}
	if r := DirectRefusals(&Workspace{Name: "ops", Worktrees: []Worktree{{Name: "main"}}}, pool[:1])["api"]; r != "" {
		t.Errorf("the holder itself: %q", r)
	}
}

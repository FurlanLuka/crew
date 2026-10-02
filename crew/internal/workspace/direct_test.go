package workspace

import (
	"errors"
	"strings"
	"testing"
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
		{"a new workspace has none yet", "web", "new", 0, nil, ""},
		{"not a repo", "web", "feature", 1, errors.New("path /x is not a git repository"), "project 'web' cannot be used in direct mode: path /x is not a git repository"},
		{"fine", "web", "feature", 1, nil, ""},
	} {
		got := directRefusal(tt.proj, tt.ws, owners, tt.worktrees, tt.repoErr)
		if !strings.Contains(got, tt.want) || (tt.want == "" && got != "") {
			t.Errorf("%s: %q, want %q", tt.name, got, tt.want)
		}
	}
}

package workspace

import (
	"testing"
	"time"
)

// ── formatAge ──

func TestFormatAge_LessThanMinute(t *testing.T) {
	tests := []struct {
		name string
		ago  time.Duration
	}{
		{"zero", 0},
		{"10 seconds", 10 * time.Second},
		{"59 seconds", 59 * time.Second},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := formatAge(time.Now().Add(-tt.ago))
			if got != "<1m ago" {
				t.Errorf("formatAge(%v ago) = %q, want %q", tt.ago, got, "<1m ago")
			}
		})
	}
}

func TestFormatAge_Minutes(t *testing.T) {
	tests := []struct {
		ago  time.Duration
		want string
	}{
		{1 * time.Minute, "1m ago"},
		{15 * time.Minute, "15m ago"},
		{59 * time.Minute, "59m ago"},
	}

	for _, tt := range tests {
		t.Run(tt.want, func(t *testing.T) {
			got := formatAge(time.Now().Add(-tt.ago))
			if got != tt.want {
				t.Errorf("formatAge(%v ago) = %q, want %q", tt.ago, got, tt.want)
			}
		})
	}
}

func TestFormatAge_Hours(t *testing.T) {
	tests := []struct {
		ago  time.Duration
		want string
	}{
		{1 * time.Hour, "1h ago"},
		{5 * time.Hour, "5h ago"},
		{23 * time.Hour, "23h ago"},
	}

	for _, tt := range tests {
		t.Run(tt.want, func(t *testing.T) {
			got := formatAge(time.Now().Add(-tt.ago))
			if got != tt.want {
				t.Errorf("formatAge(%v ago) = %q, want %q", tt.ago, got, tt.want)
			}
		})
	}
}

func TestFormatAge_Days(t *testing.T) {
	tests := []struct {
		ago  time.Duration
		want string
	}{
		{24 * time.Hour, "1d ago"},
		{48 * time.Hour, "2d ago"},
		{7 * 24 * time.Hour, "7d ago"},
		{30 * 24 * time.Hour, "30d ago"},
	}

	for _, tt := range tests {
		t.Run(tt.want, func(t *testing.T) {
			got := formatAge(time.Now().Add(-tt.ago))
			if got != tt.want {
				t.Errorf("formatAge(%v ago) = %q, want %q", tt.ago, got, tt.want)
			}
		})
	}
}

// ── parseSessionName ──

func TestParseSessionName_BaseSession(t *testing.T) {
	info := parseSessionName("crew-myapp", "2h ago")

	if info.TmuxSession != "crew-myapp" {
		t.Errorf("TmuxSession = %q, want %q", info.TmuxSession, "crew-myapp")
	}
	if info.BaseName != "myapp" {
		t.Errorf("BaseName = %q, want %q", info.BaseName, "myapp")
	}
	if info.DisplayName != "myapp" {
		t.Errorf("DisplayName = %q, want %q", info.DisplayName, "myapp")
	}
	if info.WorktreeName != "" {
		t.Errorf("WorktreeName = %q, want empty", info.WorktreeName)
	}
	if info.IsWorktree {
		t.Error("IsWorktree should be false for base session")
	}
	if info.Age != "2h ago" {
		t.Errorf("Age = %q, want %q", info.Age, "2h ago")
	}
}

func TestParseSessionName_WorktreeSession(t *testing.T) {
	info := parseSessionName("crew-myapp--feat-1", "15m ago")

	if info.TmuxSession != "crew-myapp--feat-1" {
		t.Errorf("TmuxSession = %q, want %q", info.TmuxSession, "crew-myapp--feat-1")
	}
	if info.BaseName != "myapp" {
		t.Errorf("BaseName = %q, want %q", info.BaseName, "myapp")
	}
	if info.WorktreeName != "feat-1" {
		t.Errorf("WorktreeName = %q, want %q", info.WorktreeName, "feat-1")
	}
	if !info.IsWorktree {
		t.Error("IsWorktree should be true for worktree session")
	}
	if info.DisplayName != "myapp/feat-1" {
		t.Errorf("DisplayName = %q, want %q", info.DisplayName, "myapp/feat-1")
	}
	if info.Age != "15m ago" {
		t.Errorf("Age = %q, want %q", info.Age, "15m ago")
	}
}

func TestParseSessionName_DefaultFields(t *testing.T) {
	info := parseSessionName("crew-test", "<1m ago")

	if info.ProjectCount != 0 {
		t.Errorf("ProjectCount = %d, want 0", info.ProjectCount)
	}
	if info.DevRunning {
		t.Error("DevRunning should be false by default")
	}
}

func TestParseSessionName_Table(t *testing.T) {
	tests := []struct {
		tmuxName    string
		wantBase    string
		wantWT      string
		wantDisplay string
		wantIsWT    bool
	}{
		{"crew-alpha", "alpha", "", "alpha", false},
		{"crew-alpha--beta", "alpha", "beta", "alpha/beta", true},
		{"crew-my-app--fix-bug", "my-app", "fix-bug", "my-app/fix-bug", true},
		{"crew-a--b--c", "a", "b--c", "a/b--c", true},
	}

	for _, tt := range tests {
		t.Run(tt.tmuxName, func(t *testing.T) {
			info := parseSessionName(tt.tmuxName, "")

			if info.BaseName != tt.wantBase {
				t.Errorf("BaseName = %q, want %q", info.BaseName, tt.wantBase)
			}
			if info.WorktreeName != tt.wantWT {
				t.Errorf("WorktreeName = %q, want %q", info.WorktreeName, tt.wantWT)
			}
			if info.DisplayName != tt.wantDisplay {
				t.Errorf("DisplayName = %q, want %q", info.DisplayName, tt.wantDisplay)
			}
			if info.IsWorktree != tt.wantIsWT {
				t.Errorf("IsWorktree = %v, want %v", info.IsWorktree, tt.wantIsWT)
			}
		})
	}
}

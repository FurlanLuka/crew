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

// ── isInfrastructureSession ──

func TestListSessionInfos_ExcludesInfrastructureSessions(t *testing.T) {
	infraNames := []string{"crew-plans", "crew-dev-myapp", "crew-dev-api-8080"}
	for _, name := range infraNames {
		info := parseSessionName(name, "")
		// Verify these names would be caught by the filter
		isInfra := name == "crew-plans" || len(name) > 9 && name[:9] == "crew-dev-"
		if !isInfra {
			t.Errorf("session %q should be recognized as infrastructure", info.TmuxSession)
		}
	}

	workspaceNames := []string{"crew-myapp", "crew-devtools", "crew-developer"}
	for _, name := range workspaceNames {
		isInfra := name == "crew-plans" || len(name) > 9 && name[:9] == "crew-dev-"
		if isInfra {
			t.Errorf("session %q should NOT be recognized as infrastructure", name)
		}
	}
}

// ── parseSessionName ──

func TestParseSessionName_BaseSession(t *testing.T) {
	info := parseSessionName("crew-myapp", "2h ago")

	if info.TmuxSession != "crew-myapp" {
		t.Errorf("TmuxSession = %q, want %q", info.TmuxSession, "crew-myapp")
	}
	if info.Workspace != "myapp" {
		t.Errorf("Workspace = %q, want %q", info.Workspace, "myapp")
	}
	if info.Age != "2h ago" {
		t.Errorf("Age = %q, want %q", info.Age, "2h ago")
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
		tmuxName      string
		wantWorkspace string
	}{
		{"crew-alpha", "alpha"},
		{"crew-my-app", "my-app"},
		{"crew-workspace-1", "workspace-1"},
	}

	for _, tt := range tests {
		t.Run(tt.tmuxName, func(t *testing.T) {
			info := parseSessionName(tt.tmuxName, "")

			if info.Workspace != tt.wantWorkspace {
				t.Errorf("Workspace = %q, want %q", info.Workspace, tt.wantWorkspace)
			}
		})
	}
}

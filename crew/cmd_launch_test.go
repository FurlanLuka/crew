package main

import (
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

func TestTerminalCheck(t *testing.T) {
	if msg, ok := terminalCheck(true, "fix"); !ok || msg != "" {
		t.Errorf("a terminal should pass: %q %v", msg, ok)
	}
	for _, what := range []string{"claude", "fix", "open"} {
		msg, ok := terminalCheck(false, what)
		if ok || !strings.Contains(msg, "crew "+what+" needs a terminal") {
			t.Errorf("%s without a terminal: %q %v", what, msg, ok)
		}
	}
}

func TestFixPlan(t *testing.T) {
	h := &workspace.Health{Stage: workspace.StageSmoke}
	tests := []struct {
		health     *workspace.Health
		hasServers bool
		want       fixAction
	}{
		{nil, false, fixNothingToCheck},
		{nil, true, fixVerifyFirst},
		{h, true, fixNow},
		{h, false, fixNow},
	}
	for _, tt := range tests {
		if got := fixPlan(tt.health, tt.hasServers); got != tt.want {
			t.Errorf("fixPlan(%v, %v) = %v, want %v", tt.health != nil, tt.hasServers, got, tt.want)
		}
	}
}

package main

import (
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

func TestTerminalCheck(t *testing.T) {
	if msg, ok := terminalCheck(true, "claude", "x"); !ok || msg != "" {
		t.Errorf("a terminal should pass: %q %v", msg, ok)
	}
	msg, ok := terminalCheck(false, "claude", "crew start <ref> prints the prompt")
	if ok || msg != "Error: crew claude needs a terminal — hand the user this line; crew start <ref> prints the prompt" {
		t.Errorf("without a terminal: %q %v", msg, ok)
	}
}

func TestFixPlan(t *testing.T) {
	h := &workspace.Health{Issues: []workspace.Issue{{Stage: workspace.StageSmoke}}}
	tests := []struct {
		health     *workspace.Health
		hasServers bool
		running    bool
		want       fixAction
	}{
		{nil, false, false, fixNothingToCheck},
		{nil, true, false, fixVerifyFirst},
		{nil, true, true, fixCheckRunning}, // a verify would restart them
		{h, true, false, fixNow},
		{h, true, true, fixNow},
		{h, false, false, fixNow},
	}
	for _, tt := range tests {
		if got := fixPlan(tt.health, tt.hasServers, tt.running); got != tt.want {
			t.Errorf("fixPlan(%v, %v, %v) = %v, want %v", tt.health != nil, tt.hasServers, tt.running, got, tt.want)
		}
	}
}

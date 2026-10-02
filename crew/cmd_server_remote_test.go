package main

import (
	"reflect"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/voice"
)

func TestAttachArgv(t *testing.T) {
	got := attachArgv("/h/.crew/bin/voiceos")
	want := []string{"/h/.crew/bin/voiceos", "remote", "attach"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestFormatMachineRow(t *testing.T) {
	row := voice.MachineRow{Machine: voice.Machine{ID: "vm1", Host: "dev@vm1", Name: "Build box"}, Status: "connected"}
	if got, want := formatMachineRow(row), "vm1\tBuild box\tdev@vm1\tconnected"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestAttachRefusal(t *testing.T) {
	cases := []struct {
		name     string
		unmet    []voice.Requirement
		cockpit  bool
		wantLine string
		wantCode int
	}{
		{"ready → nothing", nil, false, "", 0},
		{"tools missing → named, exit 3", []voice.Requirement{{Name: "tmux"}, {Name: "claude"}}, false, "crew-remote-error: requirements: tmux, claude", 3},
		{"the cockpit runs here → exit 4", nil, true, "crew-remote-error: cockpit-running", 4},
	}
	for _, c := range cases {
		line, code := attachRefusal(c.unmet, c.cockpit)
		if line != c.wantLine || code != c.wantCode {
			t.Errorf("%s: got (%q, %d), want (%q, %d)", c.name, line, code, c.wantLine, c.wantCode)
		}
	}
}

package main

import (
	"errors"
	"testing"
)

func TestUpdateCheck(t *testing.T) {
	for _, tt := range []struct {
		name            string
		current, latest string
		err             error
		want            updateCheckDoc
		line            string
	}{
		{"newer", "4.1.0", "4.2.0", nil, updateCheckDoc{Current: "4.1.0", Latest: "4.2.0", Available: true}, "crew v4.1.0 — v4.2.0 is available (crew update)"},
		{"same", "4.2.0", "4.2.0", nil, updateCheckDoc{Current: "4.2.0", Latest: "4.2.0"}, "crew v4.2.0 — up to date (latest v4.2.0)"},
		{"ahead of the cache", "4.3.0", "4.2.0", nil, updateCheckDoc{Current: "4.3.0", Latest: "4.2.0"}, "crew v4.3.0 — up to date (latest v4.2.0)"},
		{"a dev build", "dev", "4.2.0", nil, updateCheckDoc{Current: "dev", Latest: "4.2.0", Dev: true}, "crew (dev build) — crew update installs the latest release (v4.2.0)"},
		{"a pushed dev build", "dev-abc123", "4.2.0", nil, updateCheckDoc{Current: "dev-abc123", Latest: "4.2.0", Dev: true}, "crew (dev build abc123) — crew update installs the latest release (v4.2.0)"},
		{"a dev build offline", "dev", "", errors.New("offline"), updateCheckDoc{Current: "dev", Dev: true, Error: "offline"}, "crew (dev build) — could not ask for the latest release: offline"},
		{"offline", "4.1.0", "", errors.New("dial tcp: no route to host"), updateCheckDoc{Current: "4.1.0", Error: "dial tcp: no route to host"}, "crew v4.1.0 — could not ask for the latest release: dial tcp: no route to host"},
	} {
		got := updateCheck(tt.current, tt.latest, tt.err)
		// --json carries the text line, so the page never words it again.
		if got.Line != tt.line {
			t.Errorf("%s: line %q, want %q", tt.name, got.Line, tt.line)
		}
		got.Line = ""
		if got != tt.want {
			t.Errorf("%s: %+v, want %+v", tt.name, got, tt.want)
		}
	}
}

// crew update and its --check read one verdict: no downgrade from ahead, a
// dev build always replaced.
func TestDecideUpdate(t *testing.T) {
	for _, tt := range []struct {
		current, latest string
		want            updateVerdict
	}{
		{"dev", "4.2.0", updateDev},
		{"dev-abc123-dirty-9f", "4.2.0", updateDev},
		{"4.2.0", "4.2.0", updateCurrent},
		{"4.3.0", "4.2.0", updateCurrent},
		{"4.1.0", "4.2.0", updateNewer},
	} {
		if got := decideUpdate(tt.current, tt.latest); got != tt.want {
			t.Errorf("decideUpdate(%s, %s) = %d, want %d", tt.current, tt.latest, got, tt.want)
		}
	}
}

// A dev build has no version to put a "v" in front of.
func TestUpdatingLine(t *testing.T) {
	for _, tt := range []struct{ current, want string }{
		{"4.1.0", "Updating crew v4.1.0 → v4.2.0"},
		{"dev", "Updating crew dev build → v4.2.0"},
		{"dev-abc123", "Updating crew dev build abc123 → v4.2.0"},
	} {
		if got := updatingLine(tt.current, "4.2.0"); got != tt.want {
			t.Errorf("updatingLine(%s) = %q, want %q", tt.current, got, tt.want)
		}
	}
}

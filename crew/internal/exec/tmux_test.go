package exec

import (
	"fmt"
	"testing"
	"time"
)

func TestParseCrewSessionsOutput_Valid(t *testing.T) {
	ts := time.Date(2025, 6, 15, 12, 0, 0, 0, time.UTC).Unix()
	input := fmt.Sprintf("crew-myapp\t%d\ncrew-other\t%d\n", ts, ts+3600)

	sessions := parseCrewSessionsOutput(input)
	if len(sessions) != 2 {
		t.Fatalf("got %d sessions, want 2", len(sessions))
	}

	if sessions[0].Name != "crew-myapp" {
		t.Errorf("sessions[0].Name = %q, want %q", sessions[0].Name, "crew-myapp")
	}
	if sessions[0].CreatedAt.Unix() != ts {
		t.Errorf("sessions[0].CreatedAt = %d, want %d", sessions[0].CreatedAt.Unix(), ts)
	}

	if sessions[1].Name != "crew-other" {
		t.Errorf("sessions[1].Name = %q, want %q", sessions[1].Name, "crew-other")
	}
	if sessions[1].CreatedAt.Unix() != ts+3600 {
		t.Errorf("sessions[1].CreatedAt = %d, want %d", sessions[1].CreatedAt.Unix(), ts+3600)
	}
}

func TestParseCrewSessionsOutput_FiltersNonCrew(t *testing.T) {
	input := "crew-myapp\t1000000000\nrandom-session\t1000000001\ncrew-other\t1000000002\n"

	sessions := parseCrewSessionsOutput(input)
	if len(sessions) != 2 {
		t.Fatalf("got %d sessions, want 2 (should filter non-crew)", len(sessions))
	}
	if sessions[0].Name != "crew-myapp" {
		t.Errorf("sessions[0].Name = %q, want %q", sessions[0].Name, "crew-myapp")
	}
	if sessions[1].Name != "crew-other" {
		t.Errorf("sessions[1].Name = %q, want %q", sessions[1].Name, "crew-other")
	}
}

func TestParseCrewSessionsOutput_Empty(t *testing.T) {
	sessions := parseCrewSessionsOutput("")
	if len(sessions) != 0 {
		t.Errorf("got %d sessions for empty input, want 0", len(sessions))
	}
}

func TestParseCrewSessionsOutput_Whitespace(t *testing.T) {
	sessions := parseCrewSessionsOutput("  \n  \n")
	if len(sessions) != 0 {
		t.Errorf("got %d sessions for whitespace input, want 0", len(sessions))
	}
}

func TestParseCrewSessionsOutput_MalformedLines(t *testing.T) {
	tests := []struct {
		name  string
		input string
	}{
		{"no tab", "crew-myapp1000000000\n"},
		{"invalid timestamp", "crew-myapp\tnot-a-number\n"},
		{"empty name", "\t1000000000\n"},
		{"missing timestamp", "crew-myapp\t\n"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sessions := parseCrewSessionsOutput(tt.input)
			if len(sessions) != 0 {
				t.Errorf("got %d sessions, want 0 for malformed input", len(sessions))
			}
		})
	}
}

func TestParseCrewSessionsOutput_MixedValidAndInvalid(t *testing.T) {
	input := "crew-good\t1000000000\nbad-line\ncrew-also-good\t1000000001\ncrew-bad-ts\tnotanumber\n"

	sessions := parseCrewSessionsOutput(input)
	if len(sessions) != 2 {
		t.Fatalf("got %d sessions, want 2", len(sessions))
	}
	if sessions[0].Name != "crew-good" {
		t.Errorf("sessions[0].Name = %q, want %q", sessions[0].Name, "crew-good")
	}
	if sessions[1].Name != "crew-also-good" {
		t.Errorf("sessions[1].Name = %q, want %q", sessions[1].Name, "crew-also-good")
	}
}

func TestParseCrewSessionsOutput_WorktreeSession(t *testing.T) {
	input := "crew-myapp--feat-1\t1000000000\n"

	sessions := parseCrewSessionsOutput(input)
	if len(sessions) != 1 {
		t.Fatalf("got %d sessions, want 1", len(sessions))
	}
	if sessions[0].Name != "crew-myapp--feat-1" {
		t.Errorf("Name = %q, want %q", sessions[0].Name, "crew-myapp--feat-1")
	}
}

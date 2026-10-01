package main

import (
	"encoding/json"
	"os"
	"testing"
)

func TestParseHandoffArgsSharedFixture(t *testing.T) {
	data, err := os.ReadFile("../voiceos/test/fixtures/shared/dev-handoff.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct{ Allowed, Refused [][]string }
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, args := range fixture.Allowed {
		h, err := parseHandoffArgs(append(args, "--source=vm1"))
		if err != nil || h.version != args[0] || h.dir != args[1] || h.source != "vm1" {
			t.Errorf("%v: got %+v, %v", args, h, err)
		}
	}
	for _, args := range fixture.Refused {
		if _, err := parseHandoffArgs(append(args, "--source=vm1")); err == nil {
			t.Errorf("%v: want refused", args)
		}
	}
	ok := fixture.Allowed[0]
	for _, source := range []string{"--source=main", "--source=", "--source=VM 1", "vm1"} {
		if _, err := parseHandoffArgs(append(append([]string{}, ok...), source)); err == nil {
			t.Errorf("%q: want refused", source)
		}
	}
	if _, err := parseHandoffArgs(ok); err == nil {
		t.Error("no source: want refused")
	}
}

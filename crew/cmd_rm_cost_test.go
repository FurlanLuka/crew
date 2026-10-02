package main

import (
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// Every row has the output format's six columns, whatever the checkout.
func TestCostLine_SixColumns(t *testing.T) {
	for _, c := range []workspace.CheckoutCost{
		{Ref: "ws/main", Project: "api", Path: "/w/ws/main/api", Uncommitted: 2, Commits: 1, SizeBytes: 2048},
		{Ref: "ws/main", Project: "signals", Path: "/code/signals", Direct: true},
		{Ref: "ws/main", Project: "web", Path: "/w/ws/main/web", Missing: true},
	} {
		if cols := strings.Split(costLine(c), "\t"); len(cols) != 6 {
			t.Errorf("%s: %d columns: %q", c.Project, len(cols), cols)
		}
	}
	if got := costLine(workspace.CheckoutCost{Ref: "ws/main", Project: "signals", Path: "/code/signals", Direct: true}); got != "ws/main\tsignals\t/code/signals\tdirect — the canonical checkout is kept\t-\t-" {
		t.Errorf("direct = %q", got)
	}
}

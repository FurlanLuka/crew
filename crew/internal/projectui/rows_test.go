package projectui

import (
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// The cursor's path: install, servers, bindings, proposals (capped), the
// check row last; the jumps land on a section's first row or -1.
func TestPageRows(t *testing.T) {
	empty := pageRows(pageFacts{})
	if len(empty) != 5 || empty[2].Kind != rowNoServers || empty[3].Kind != rowNoBindings || empty[4].Kind != rowCheck {
		t.Errorf("empty project rows = %+v", empty)
	}
	if rowFor(empty, rowServer) != -1 || rowFor(empty, rowBinding) != -1 || rowFor(empty, rowCheck) != 4 {
		t.Error("rowFor on an empty section is -1")
	}

	f := pageFacts{
		proj: project.Project{
			DevServers: []project.DevServer{{Name: "web"}, {Name: "worker"}},
			Bindings:   []project.Binding{{Var: "A", Value: "x"}, {Var: "A", Value: "y", Server: "worker"}},
		},
		proposals: []dev.Proposal{{Var: "P1"}, {Var: "P2"}, {Var: "P3"}, {Var: "P4"}, {Var: "P5"}},
	}
	rows := pageRows(f)
	var keys []string
	for _, r := range rows {
		keys = append(keys, r.Key)
	}
	if got := strings.Join(keys, ","); got != "setup,env,web,worker,A,A (worker),P1,P2,P3,check" {
		t.Errorf("rows = %s", got)
	}
	if rows[5].Kind != rowBinding || rows[5].Index != 1 || rows[6].Kind != rowProposal || rows[6].Index != 0 {
		t.Errorf("indices: %+v", rows[5:7])
	}
	if rowFor(rows, rowServer) != 2 || rowFor(rows, rowBinding) != 4 || rowFor(rows, rowProposal) != 6 {
		t.Error("rowFor lands on the first of a kind")
	}
	if findRow(rows, rowBinding, "A (worker)") != 5 || findRow(rows, rowServer, "gone") != -1 {
		t.Error("findRow re-finds a row by identity")
	}
	// A jump to an empty section lands on its placeholder; to bindings
	// with only proposals, on the first proposal.
	if jumpTo(empty, rowServer) != 2 || jumpTo(empty, rowBinding) != 3 || jumpTo(rows, rowBinding) != 4 {
		t.Errorf("jumpTo: %d %d %d", jumpTo(empty, rowServer), jumpTo(empty, rowBinding), jumpTo(rows, rowBinding))
	}
	proposalsOnly := pageRows(pageFacts{proposals: []dev.Proposal{{Var: "P"}}})
	if got := proposalsOnly[jumpTo(proposalsOnly, rowBinding)].Kind; got != rowProposal {
		t.Errorf("b with proposals only lands on the first proposal: %v", got)
	}
}

func TestPageKeysAndCLI(t *testing.T) {
	f := pageFacts{proj: project.Project{DevServers: []project.DevServer{{Name: "web"}}, Bindings: []project.Binding{{Var: "A", Value: "x"}}}, proposals: []dev.Proposal{{Var: "P"}}}
	rows := pageRows(f)
	for _, tt := range []struct {
		cursor int
		facts  facts
		want   string
		cli    string
	}{
		{0, facts{}, "enter edit  esc back", "crew add project api --setup=<cmd> --env-cmd=<cmd>"},
		{2, facts{}, "enter edit  a add  d remove  esc back", "crew dev add api --name --port --cmd [--dir] · crew dev rm api <server>"},
		{3, facts{}, "enter edit  a add  d remove  esc back", "crew add binding api[/<server>] --var=<VAR> --url=<proj> · crew rm binding api <VAR>"},
		{4, facts{}, "enter add this one  A add all found  a add by hand  esc back", "crew add binding api --scan --apply"},
		{5, facts{}, "c check  esc back", "crew check project api --wait · crew fix check/api"},
		{5, facts{phase: checkFailed}, "c check again  l logs  esc back", "crew check project api --wait · crew fix check/api"},
		{5, facts{phase: checkFailed, canFix: true}, "c check again  l logs  f fix with Claude  esc back", "crew check project api --wait · crew fix check/api"},
		{2, facts{}, "enter edit  a add  d remove  esc back", "crew dev add api --name --port --cmd [--dir] · crew dev rm api <server>"},
		{0, facts{phase: checkRunning}, "l logs  esc back", "crew add project api --setup=<cmd> --env-cmd=<cmd>"},
		{0, facts{phase: checkConfirm}, "y discard and check again  n keep", "crew add project api --setup=<cmd> --env-cmd=<cmd>"},
	} {
		if got := strings.Join(pageKeys(rows, tt.cursor, tt.facts), "  "); got != tt.want {
			t.Errorf("keys at %d %+v = %q, want %q", tt.cursor, tt.facts, got, tt.want)
		}
		if got := pageCLI(rows, tt.cursor, "api"); got != tt.cli {
			t.Errorf("cli at %d = %q, want %q", tt.cursor, got, tt.cli)
		}
	}
}

func TestPageKeys_Placeholders(t *testing.T) {
	rows := pageRows(pageFacts{})
	if got := strings.Join(pageKeys(rows, 2, facts{}), "  "); got != "a add  esc back" {
		t.Errorf("placeholder keys = %q", got)
	}
	if got := pageCLI(rows, 3, "api"); !strings.HasPrefix(got, "crew add binding api") {
		t.Errorf("placeholder cli = %q", got)
	}
}

func TestUnboundProposals(t *testing.T) {
	proposals := []dev.Proposal{{Var: "A"}, {Var: "B"}, {Var: "C"}}
	got := unboundProposals(proposals, []project.Binding{{Var: "B", Server: "web"}})
	if len(got) != 2 || got[0].Var != "A" || got[1].Var != "C" {
		t.Errorf("a bound var leaves the list whatever its scope: %+v", got)
	}
}

// window keeps the cursor on screen and never over-runs the lines.
func TestWindow(t *testing.T) {
	lines := []string{"0", "1", "2", "3", "4", "5", "6", "7", "8", "9"}
	for _, tt := range []struct {
		cursor, height int
		want           string
	}{
		{0, 0, "0123456789"},
		{0, 20, "0123456789"},
		{0, 4, "0123"},
		{3, 4, "0123"},
		{4, 4, "1234"},
		{9, 4, "6789"},
		{9, 1, "9"},
	} {
		if got := strings.Join(window(lines, tt.cursor, tt.height), ""); got != tt.want {
			t.Errorf("window(cursor %d, height %d) = %q, want %q", tt.cursor, tt.height, got, tt.want)
		}
	}
}

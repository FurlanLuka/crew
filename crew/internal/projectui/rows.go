package projectui

import (
	"fmt"

	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// rowKind is what a page row stands for.
type rowKind int

const (
	rowSetup rowKind = iota
	rowEnv
	rowServer
	rowNoServers // the placeholder of an empty section: a adds there
	rowBinding
	rowProposal
	rowNoBindings
	rowCheck
)

// pageRow is one thing the cursor can land on. Key names the row across
// reloads — a server's name, a binding's label, a proposal's var — so the
// cursor is re-found by identity, never kept as an index that a reload
// would move from under it.
type pageRow struct {
	Kind  rowKind
	Index int // into the facts' servers / bindings / proposals
	Key   string
}

func (r pageRow) section() section {
	switch r.Kind {
	case rowSetup, rowEnv:
		return sectionInstall
	case rowServer, rowNoServers:
		return sectionServers
	case rowBinding, rowProposal, rowNoBindings:
		return sectionBindings
	}
	return sectionCheck
}

// maxProposalRows is how many found-in-.env rows the page lists; the rest
// fold into one "+N more" line, and A takes them all.
const maxProposalRows = 3

// pageRows is the cursor's path through the page: install, servers,
// bindings (then the proposals), the check row last. An empty section
// keeps one row — its placeholder — so the cursor can stand in it and a
// adds there. Pure.
func pageRows(f pageFacts) []pageRow {
	rows := []pageRow{{Kind: rowSetup, Key: "setup"}, {Kind: rowEnv, Key: "env"}}
	for i, ds := range f.proj.DevServers {
		rows = append(rows, pageRow{Kind: rowServer, Index: i, Key: ds.Name})
	}
	if len(f.proj.DevServers) == 0 {
		rows = append(rows, pageRow{Kind: rowNoServers, Key: "servers"})
	}
	for i, b := range f.proj.Bindings {
		rows = append(rows, pageRow{Kind: rowBinding, Index: i, Key: b.Label()})
	}
	for i, p := range f.proposals {
		if i == maxProposalRows {
			break
		}
		rows = append(rows, pageRow{Kind: rowProposal, Index: i, Key: p.Var})
	}
	if len(f.proj.Bindings) == 0 && len(f.proposals) == 0 {
		rows = append(rows, pageRow{Kind: rowNoBindings, Key: "bindings"})
	}
	return append(rows, pageRow{Kind: rowCheck, Key: "check"})
}

// rowFor is the first row of a kind, -1 when the section is empty — what
// the t/e/s/b jumps land on, so they cannot drift from the rows. Pure.
func rowFor(rows []pageRow, kind rowKind) int {
	for i, r := range rows {
		if r.Kind == kind {
			return i
		}
	}
	return -1
}

// jumpTo is where a section letter lands: the section's first row — a
// proposal or the placeholder when nothing is bound yet. Pure.
func jumpTo(rows []pageRow, kind rowKind) int {
	if i := rowFor(rows, kind); i >= 0 {
		return i
	}
	switch kind {
	case rowServer:
		return rowFor(rows, rowNoServers)
	case rowBinding:
		if i := rowFor(rows, rowProposal); i >= 0 {
			return i
		}
		return rowFor(rows, rowNoBindings)
	}
	return max(0, rowFor(rows, rowSetup))
}

// findRow re-finds a row by identity after a reload, -1 when it is gone.
func findRow(rows []pageRow, kind rowKind, key string) int {
	for i, r := range rows {
		if r.Kind == kind && r.Key == key {
			return i
		}
	}
	return -1
}

// pageKeys is the key line for the row under the cursor — the one table
// the handler reads too, so a key the help offers is one the handler
// takes. Pure.
func pageKeys(rows []pageRow, cursor int, f facts) []string {
	if f.phase == checkConfirm {
		return []string{"y discard and check again", "n keep"}
	}
	if f.phase == checkRunning {
		return []string{"l logs", "esc back"}
	}
	if cursor < 0 || cursor >= len(rows) {
		return []string{"esc back"}
	}
	var keys []string
	switch rows[cursor].Kind {
	case rowSetup, rowEnv:
		keys = []string{"enter edit"}
	case rowServer:
		keys = []string{"enter edit", "a add", "d remove"}
	case rowBinding:
		keys = []string{"enter edit", "a add", "d remove"}
	case rowProposal:
		keys = []string{"enter add this one", "A add all found", "a add by hand"}
	case rowNoServers, rowNoBindings:
		keys = []string{"a add"}
	case rowCheck:
		switch f.phase {
		case checkFailed:
			keys = []string{"c check again", "l logs"}
			if f.canFix {
				keys = append(keys, "f fix with Claude")
			}
		default:
			keys = []string{"c check"}
		}
	}
	return append(keys, "esc back")
}

// pageCLI names the command the row under the cursor stands for. Pure.
func pageCLI(rows []pageRow, cursor int, name string) string {
	if cursor < 0 || cursor >= len(rows) {
		return ""
	}
	switch rows[cursor].Kind {
	case rowSetup, rowEnv:
		return fmt.Sprintf("crew add project %s --setup=<cmd> --env-cmd=<cmd>", name)
	case rowServer, rowNoServers:
		return fmt.Sprintf("crew dev add %s --name --port --cmd [--dir] · crew dev rm %s <server>", name, name)
	case rowBinding, rowNoBindings:
		return fmt.Sprintf("crew add binding %s[/<server>] --var=<VAR> --url=<proj> · crew rm binding %s <VAR>", name, name)
	case rowProposal:
		return fmt.Sprintf("crew add binding %s --scan --apply", name)
	}
	return fmt.Sprintf("crew check project %s --wait · crew fix check/%s", name, name)
}

// confirmPrompt is the (y/n) question d asks over a row, naming what goes
// with it; "" for a row with nothing to remove. Pure.
func confirmPrompt(p project.Project, r pageRow) string {
	switch r.Kind {
	case rowServer:
		ds := p.DevServers[r.Index]
		if n := len(project.ScopedTo(p.Bindings, ds.Name)); n > 0 {
			return fmt.Sprintf("Remove server '%s' and the %d binding(s) scoped to it? (y/n)", ds.Name, n)
		}
		return fmt.Sprintf("Remove server '%s'? (y/n)", ds.Name)
	case rowBinding:
		return fmt.Sprintf("Remove binding '%s'? (y/n)", p.Bindings[r.Index].Label())
	}
	return ""
}

// unboundProposals is what the scan found that is not bound yet, in the
// scan's order; a bound var leaves the list — there is no dismissing.
// Pure.
func unboundProposals(proposals []dev.Proposal, bindings []project.Binding) []dev.Proposal {
	declared := project.DeclaredVars(bindings)
	var out []dev.Proposal
	for _, p := range proposals {
		if !declared[p.Var] {
			out = append(out, p)
		}
	}
	return out
}

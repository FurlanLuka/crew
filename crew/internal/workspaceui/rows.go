package workspaceui

import (
	"fmt"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// rowKind is what a page row stands for.
type rowKind int

const (
	rowProject    rowKind = iota
	rowNoProjects         // the placeholder of an empty section: a adds there
	rowWorktree
	rowNewWorktree
)

// pageRow is one thing the cursor can land on. Key names the row across
// reloads — a member's name, a worktree's ref — so the cursor is re-found
// by identity, never kept as an index that a reload would move from under
// it.
type pageRow struct {
	Kind  rowKind
	Index int // into the facts' members / summaries
	Key   string
}

// pageRows is the cursor's path through the page: the members (or the
// placeholder), then the worktrees, then + new worktree. Pure.
func pageRows(f pageFacts) []pageRow {
	var rows []pageRow
	for i, wp := range f.members() {
		rows = append(rows, pageRow{Kind: rowProject, Index: i, Key: wp.Name})
	}
	if len(f.members()) == 0 {
		rows = append(rows, pageRow{Kind: rowNoProjects, Key: "projects"})
	}
	for i, s := range f.summaries {
		rows = append(rows, pageRow{Kind: rowWorktree, Index: i, Key: s.Ref.String()})
	}
	return append(rows, pageRow{Kind: rowNewWorktree, Key: "new"})
}

// rowFor is the first row of a kind, -1 when there is none. Pure.
func rowFor(rows []pageRow, kind rowKind) int {
	for i, r := range rows {
		if r.Kind == kind {
			return i
		}
	}
	return -1
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

// landOn is the first row of a kind, the section's placeholder when it
// is empty, the first worktree otherwise — where a fresh page opens (a
// worktree is what one acts on; the members above it are config) and
// where the cursor goes after a removal took its row. Pure.
func landOn(rows []pageRow, kind rowKind) int {
	if i := rowFor(rows, kind); i >= 0 {
		return i
	}
	if kind == rowProject {
		if i := rowFor(rows, rowNoProjects); i >= 0 {
			return i
		}
	}
	if i := rowFor(rows, rowWorktree); i >= 0 {
		return i
	}
	return max(0, rowFor(rows, rowNewWorktree))
}

// pageKeys is the key line for the row under the cursor and the open
// form — the one table the handler reads too; ctrl+p is offered only
// while a base is behind. Pure.
func pageKeys(rows []pageRow, cursor int, open openKind, flat, stale bool) []string {
	switch open {
	case openPicker:
		return []string{pickerKeys, "enter add", "esc back"}
	case openNewWorktree:
		if stale {
			return []string{"enter create", "ctrl+p pull first", "esc back"}
		}
		return []string{"enter create", "esc back"}
	case openDuplicate:
		return []string{"enter duplicate", "esc back"}
	}
	if cursor < 0 || cursor >= len(rows) {
		return []string{"esc back"}
	}
	var keys []string
	switch rows[cursor].Kind {
	case rowProject:
		keys = []string{"enter open", "a add project", "d remove"}
	case rowNoProjects:
		keys = []string{"a add project"}
	case rowWorktree:
		if flat {
			keys = []string{"enter open", "d remove"}
		} else {
			keys = []string{"enter open", "u duplicate", "n new", "d remove"}
		}
	case rowNewWorktree:
		keys = []string{"enter create"}
	}
	return append(keys, "esc back")
}

// pageCLI names the command the row under the cursor stands for. Pure.
func pageCLI(rows []pageRow, cursor int, ws string) string {
	if cursor < 0 || cursor >= len(rows) {
		return ""
	}
	switch rows[cursor].Kind {
	case rowProject:
		return fmt.Sprintf("crew rm workspace %s %s · crew add workspace %s <project> [--direct]", ws, rows[cursor].Key, ws)
	case rowNoProjects:
		return fmt.Sprintf("crew add workspace %s <project> … [--direct]", ws)
	case rowWorktree:
		if !strings.Contains(rows[cursor].Key, "/") {
			// A flat pre-2.0 workspace: the one command that applies.
			return "crew migrate — names this workspace's checkout so worktrees can be added"
		}
		return fmt.Sprintf("crew %s · crew duplicate %s <name> · crew rm worktree %s", rows[cursor].Key, rows[cursor].Key, rows[cursor].Key)
	case rowNewWorktree:
		if len(rows) > 1 && rows[cursor-1].Kind == rowWorktree && !strings.Contains(rows[cursor-1].Key, "/") {
			return "crew migrate first — a pre-2.0 workspace cannot take a worktree"
		}
	}
	return fmt.Sprintf("crew add worktree %s/<name> [--pull]", ws)
}

// memberRemovePrompt is d's (y/n) question over a member, saying what
// goes with it. Pure.
func memberRemovePrompt(ws string, wp workspace.WorkspaceProject) string {
	if workspace.IsDirect(wp) {
		return fmt.Sprintf("Remove %s from %s? The canonical repo is left alone. (y/n)", wp.Name, ws)
	}
	return fmt.Sprintf("Remove %s from %s? Its checkout in every worktree goes to the trash. (y/n)", wp.Name, ws)
}

package workspace

import (
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// BaseStatus is where a new worktree of one project would branch from.
//
// A worktree branches from the canonical repo's base branch as it is locally —
// not from the remote. So before creating one it is worth knowing whether
// that local base is behind, and what the canonical checkout is actually
// sitting on (it is often a feature branch, not the base).
type BaseStatus struct {
	Project string
	Base    string // branch the worktree will branch from
	Current string // branch the canonical checkout is on right now
	Behind  int    // commits behind origin/<base>; -1 when unknown
	Ahead   int
	Err     string // fetch or lookup failure, when it happened
}

const fetchTimeout = 8 * time.Second

// baseStatus reads one project. It fetches the base branch so "behind" means
// behind the remote as of now, not as of the last time someone pulled.
func baseStatus(p project.Project) BaseStatus {
	st := BaseStatus{Project: p.Name, Base: detectDefaultBranch(p.Path), Current: currentBranch(p.Path), Behind: -1, Ahead: -1}
	if st.Base == "HEAD" {
		st.Err = "no develop or main branch"
		return st
	}

	if _, err := exec.RunGitCommandTimeout(p.Path, fetchTimeout, "fetch", "--quiet", "origin", st.Base); err != nil {
		st.Err = "fetch failed — remote state unknown"
		return st
	}

	out, err := exec.RunGitCommand(p.Path, "rev-list", "--left-right", "--count", st.Base+"...origin/"+st.Base)
	if err != nil {
		st.Err = "no origin/" + st.Base
		return st
	}
	fields := strings.Fields(out)
	if len(fields) == 2 {
		st.Ahead, _ = strconv.Atoi(fields[0])
		st.Behind, _ = strconv.Atoi(fields[1])
	}
	return st
}

// BaseStatuses reads every project in a workspace, in parallel — each one
// fetches, and a five-project workspace should not take five fetches' worth
// of wall clock.
func BaseStatuses(ws *Workspace) []BaseStatus {
	statuses := make([]BaseStatus, len(ws.Projects))
	var wg sync.WaitGroup
	for i, wp := range ws.Projects {
		p := project.Get(wp.Name)
		if p == nil {
			statuses[i] = BaseStatus{Project: wp.Name, Err: "not in project pool", Behind: -1}
			continue
		}
		if IsDirect(wp) {
			statuses[i] = BaseStatus{Project: wp.Name, Base: "(direct — shares the canonical checkout)", Current: currentBranch(p.Path), Behind: -1}
			continue
		}
		wg.Add(1)
		go func(i int, p project.Project) {
			defer wg.Done()
			statuses[i] = baseStatus(p)
		}(i, *p)
	}
	wg.Wait()
	return statuses
}

// Stale reports whether any project's base is behind its remote.
func Stale(statuses []BaseStatus) bool {
	for _, st := range statuses {
		if st.Behind > 0 {
			return true
		}
	}
	return false
}

// FormatBaseStatuses renders the table shown before a worktree is created.
// Pure.
func FormatBaseStatuses(statuses []BaseStatus) string {
	width := 0
	for _, st := range statuses {
		width = max(width, len(st.Project))
	}

	var b strings.Builder
	for _, st := range statuses {
		fmt.Fprintf(&b, "  %-*s  ", width, st.Project)
		switch {
		case st.Err != "" && st.Base == "":
			fmt.Fprintf(&b, "%s\n", st.Err)
			continue
		case st.Err != "":
			fmt.Fprintf(&b, "%-10s  %s", st.Base, st.Err)
		case st.Behind > 0:
			fmt.Fprintf(&b, "%-10s  %d behind origin/%s", st.Base, st.Behind, st.Base)
			if st.Ahead > 0 {
				fmt.Fprintf(&b, ", %d ahead", st.Ahead)
			}
		case st.Ahead > 0:
			fmt.Fprintf(&b, "%-10s  up to date, %d ahead", st.Base, st.Ahead)
		default:
			fmt.Fprintf(&b, "%-10s  up to date", st.Base)
		}
		if st.Current != "" && st.Current != st.Base && !strings.HasPrefix(st.Base, "(") {
			fmt.Fprintf(&b, "   (checkout is on %s)", st.Current)
		}
		b.WriteString("\n")
	}
	return b.String()
}

// StaleWarning is the line printed under the table when a base is behind.
// Warn, never block: branching from a stale base is a choice, not an error,
// and the fix is one command away.
func StaleWarning(statuses []BaseStatus) string {
	var behind []string
	for _, st := range statuses {
		if st.Behind > 0 {
			behind = append(behind, st.Project)
		}
	}
	if len(behind) == 0 {
		return ""
	}
	if len(behind) == 1 {
		return fmt.Sprintf("! %s is behind origin — the worktree branches from the local base. Pull first for the latest.", behind[0])
	}
	return fmt.Sprintf("! %d of %d projects behind origin — worktrees branch from the local base. Pull first for the latest.",
		len(behind), len(statuses))
}

// UpdateBase fast-forwards a project's local base branch to origin.
//
// The canonical checkout is usually on a feature branch, so a plain `git pull`
// there would update the wrong thing. `git fetch origin base:base` moves the
// local base ref without touching the working tree, and refuses anything
// that is not a fast-forward. When base is the checked-out branch git refuses
// that form, so it becomes a ff-only merge — which only runs on a clean tree.
func UpdateBase(p project.Project) error {
	base := detectDefaultBranch(p.Path)
	if base == "HEAD" {
		return fmt.Errorf("%s: no develop or main branch", p.Name)
	}

	if currentBranch(p.Path) != base {
		if _, err := exec.RunGitCommandTimeout(p.Path, fetchTimeout, "fetch", "--quiet", "origin", base+":"+base); err != nil {
			return fmt.Errorf("%s: fast-forwarding %s failed — local %s has commits origin does not", p.Name, base, base)
		}
		return nil
	}

	if out, _ := exec.RunGitCommand(p.Path, "status", "--porcelain"); strings.TrimSpace(out) != "" {
		return fmt.Errorf("%s: %s is checked out with uncommitted changes — commit or stash first", p.Name, base)
	}
	if _, err := exec.RunGitCommandTimeout(p.Path, fetchTimeout, "fetch", "--quiet", "origin", base); err != nil {
		return fmt.Errorf("%s: fetch failed", p.Name)
	}
	if _, err := exec.RunGitCommand(p.Path, "merge", "--ff-only", "--quiet", "origin/"+base); err != nil {
		return fmt.Errorf("%s: %s cannot fast-forward — local commits diverge from origin", p.Name, base)
	}
	return nil
}

// UpdateBases pulls every behind project in a workspace, in parallel, and
// returns the failures. Projects already up to date, direct, or unknown are
// left alone.
func UpdateBases(ws *Workspace, statuses []BaseStatus) []error {
	var (
		wg     sync.WaitGroup
		mu     sync.Mutex
		failed []error
	)
	for _, st := range statuses {
		if st.Behind <= 0 {
			continue
		}
		p := project.Get(st.Project)
		if p == nil {
			continue
		}
		wg.Add(1)
		go func(p project.Project) {
			defer wg.Done()
			if err := UpdateBase(p); err != nil {
				mu.Lock()
				failed = append(failed, err)
				mu.Unlock()
			}
		}(*p)
	}
	wg.Wait()
	return failed
}

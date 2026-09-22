package workspace

import (
	"fmt"
	"os"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// RenameWorktree gives a worktree a new name: its directory, each
// checkout's crew branch and everything keyed by its slug move, and the
// record follows last. Files move first so nothing points at a directory
// that is not there; the move is re-runnable, a checkout already moved is
// skipped. Refused while crew's own servers or runners are alive on it —
// those own the old paths. Returns the new ref and the warnings worth a
// line: a checkout kept on its own branch.
func RenameWorktree(from Ref, newName string) (Ref, []string, error) {
	if from.Workspace == CheckWorkspace {
		return Ref{}, nil, fmt.Errorf("a check target is not renamable — it is a scratch checkout crew check project makes and throws away")
	}
	to, members, err := renameLocked(from, newName)
	if err != nil {
		return Ref{}, nil, err
	}
	warnings := renameWarnings(to, members)
	if res, err := Resolve(to); err != nil {
		debug.Log("setup", "%s: does not resolve after the rename: %v", to, err)
	} else if _, err := GeneratePrompt(res); err != nil {
		debug.Log("setup", "%s: prompt not regenerated after the rename: %v", to, err)
	}
	return to, warnings, nil
}

// renameLocked is the rename under the workspace file's lock — a
// concurrent add worktree under the new name would otherwise find the
// directory free, then the file would hold the name twice. Nothing in
// here may go through Update: it takes the same flock. Returns the new
// ref and the members, for the warnings.
func renameLocked(from Ref, newName string) (Ref, []WorkspaceProject, error) {
	unlock, err := lockWorkspace(from.Workspace)
	if err != nil {
		return Ref{}, nil, err
	}
	defer unlock()

	ws, err := Load(from.Workspace)
	if err != nil {
		return Ref{}, nil, err
	}
	if len(ws.Worktrees) == 0 {
		return Ref{}, nil, errFlatRef
	}
	src, err := selectWorktree(ws, from.Worktree)
	if err != nil {
		return Ref{}, nil, err
	}
	i := worktreeIndex(ws, src.Name)
	from.Worktree = src.Name
	to := Ref{Workspace: from.Workspace, Worktree: newName}
	if err := renameAllowed(ws, from, to); err != nil {
		return Ref{}, nil, err
	}
	debug.Log("git", "rename %s → %s", from, to)
	if err := moveCheckouts(from, to, ws.Projects); err != nil {
		return Ref{}, nil, err
	}
	moveSlugArtifacts(from, to)

	ws.Worktrees[i].Name = newName
	if err := Save(ws); err != nil {
		return Ref{}, nil, err
	}
	return to, ws.Projects, nil
}

// renameAllowed is every pre-flight: the shape of the name, the records,
// the state of the two directories, the branches a checkout would take,
// and nothing of crew's alive on the worktree.
func renameAllowed(ws *Workspace, from, to Ref) error {
	if err := ValidateName("worktree", to.Worktree); err != nil {
		return err
	}
	if to.Worktree == from.Worktree {
		return fmt.Errorf("'%s' is already the worktree's name", from.Worktree)
	}
	if worktreeIndex(ws, to.Worktree) >= 0 {
		return fmt.Errorf("workspace '%s' already has a worktree '%s'", ws.Name, to.Worktree)
	}
	strays := strayEntries(from, to)
	switch classifyDirs(dirExists(WorktreeDir(from)), dirExists(WorktreeDir(to)), strays, hasCheckouts(ws)) {
	case dirOccupied:
		return fmt.Errorf("%s already holds %s — move or remove it first", WorktreeDir(to), strings.Join(strays, ", "))
	case dirLost:
		return fmt.Errorf("nothing at %s — an earlier rename already moved it; run it again with the new name that rename used", WorktreeDir(from))
	}
	for _, wp := range ws.Projects {
		if IsDirect(wp) {
			continue
		}
		p := project.Get(wp.Name)
		if p == nil || !dirExists(WorktreePath(from, wp.Name)) {
			// Nothing to move for it — or it moved already, and the
			// branch it holds is its own.
			continue
		}
		branch := BranchName(to, wp.Name)
		if out, err := exec.RunGitCommand(p.Path, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch); err == nil && strings.TrimSpace(out) != "" {
			return fmt.Errorf("branch %s already exists in %s — delete or rename it first", branch, p.Path)
		}
	}
	slug := from.Slug()
	if dev.Running(slug) || exec.TmuxSessionExists(dev.SessionName(slug)) {
		return fmt.Errorf("%w on %s — crew dev stop %s first", ErrServersRunning, from, from)
	}
	if SetupRunning(from) || exec.TmuxSessionExists(dev.SetupSessionName(slug)) {
		return fmt.Errorf("%w on %s — crew setup status %s", ErrSetupRunning, from, from)
	}
	return nil
}

// dirState is what the two directories say about the rename.
type dirState int

const (
	dirFresh    dirState = iota // the old dir is there, the new one free
	dirResume                   // an earlier rename moved files and stopped: finish it
	dirOccupied                 // an entry is at both paths: not this rename's doing
	dirLost                     // neither dir is there, though checkouts are expected
)

// classifyDirs decides from the two directories alone. strays are the
// entries under the new dir that still have a counterpart under the old
// one — anything the move could not have put there. Pure.
func classifyDirs(fromExists, toExists bool, strays []string, expectCheckouts bool) dirState {
	switch {
	case len(strays) > 0:
		return dirOccupied
	case toExists:
		return dirResume
	case !fromExists && expectCheckouts:
		return dirLost
	}
	return dirFresh
}

// strayEntries is every entry under the new dir that the move could not
// have put there: its counterpart is still under the old dir.
func strayEntries(from, to Ref) []string {
	entries, err := os.ReadDir(WorktreeDir(to))
	if err != nil {
		return nil
	}
	var strays []string
	for _, e := range entries {
		if _, err := os.Lstat(WorktreePath(from, e.Name())); err == nil {
			strays = append(strays, e.Name())
		}
	}
	return strays
}

// moveSlugArtifacts carries the setup results and logs and the dev logs
// to the new slug, and drops what is regenerated — routes, prompt,
// .code-workspace — for both.
func moveSlugArtifacts(from, to Ref) {
	moveEvidence("setup", SetupDir(from.Slug()), SetupDir(to.Slug()))
	moveEvidence("dev", dev.LogDir(from.Slug()), dev.LogDir(to.Slug()))
	for _, ref := range []Ref{from, to} {
		os.Remove(dev.RoutesFilePath(ref.Slug()))
		os.Remove(PromptFilePath(ref))
		os.Remove(CodeWorkspaceFilePath(ref))
	}
}

// moveEvidence moves one slug-keyed directory. Best effort: a directory
// housekeeping swept meanwhile is evidence, not state, and must not fail
// the rename. A leftover under the new slug is a removed worktree's,
// replaced, never merged.
func moveEvidence(category, src, dst string) {
	if !dirExists(src) {
		return
	}
	os.RemoveAll(dst)
	if err := os.Rename(src, dst); err != nil {
		debug.Log(category, "rename: %s not moved to %s: %v", src, dst, err)
	}
}

// renameWarnings is what the caller should say after a rename: each
// checkout that is not on its crew branch kept whatever it was on. What
// every rename implies — shells, editors and agents opened on the old
// paths still hold them — is the CLI's standing line, not a warning.
func renameWarnings(to Ref, members []WorkspaceProject) []string {
	var out []string
	for _, wp := range members {
		if IsDirect(wp) {
			continue
		}
		dir := WorktreePath(to, wp.Name)
		if !dirExists(dir) {
			continue
		}
		if head := currentBranch(dir); head != "" && head != BranchName(to, wp.Name) {
			out = append(out, fmt.Sprintf("%s kept — on %s", wp.Name, head))
		}
	}
	return out
}

func worktreeIndex(ws *Workspace, name string) int {
	for i, wt := range ws.Worktrees {
		if wt.Name == name {
			return i
		}
	}
	return -1
}

// hasCheckouts: at least one member is a worktree-mode project, so a
// worktree directory is expected to exist.
func hasCheckouts(ws *Workspace) bool {
	for _, wp := range ws.Projects {
		if !IsDirect(wp) {
			return true
		}
	}
	return false
}

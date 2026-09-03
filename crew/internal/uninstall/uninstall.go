package uninstall

import (
	"fmt"
	"os"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// Report says what Run removed and what it deliberately left.
type Report struct {
	Binary     string
	Workspaces []string // removed only with purge
	Kept       string   // config dir left in place, empty when purged
}

// Run stops everything crew started and removes the binary.
//
// Without purge, ~/.crew stays: it holds every worktree checkout, with real
// branches and possibly uncommitted work, and the workspace config that names
// them. Deleting that is a separate decision, so it takes a flag. With purge,
// each workspace is removed through workspace.Remove — which detaches the git
// worktrees properly rather than leaving the canonical repos pointing at
// directories that no longer exist — and then the config dir goes.
func Run(purge bool) (Report, error) {
	var report Report

	debug.Log("uninstall", "stopping all dev sessions (purge=%v)", purge)
	dev.StopAll("")

	if purge {
		names, err := workspace.List()
		if err != nil {
			return report, err
		}
		for _, name := range names {
			if err := workspace.Remove(name); err != nil {
				return report, fmt.Errorf("removing workspace %s: %w", name, err)
			}
			report.Workspaces = append(report.Workspaces, name)
		}
		if err := os.RemoveAll(config.ConfigDir); err != nil {
			return report, fmt.Errorf("removing %s: %w", config.ConfigDir, err)
		}
	} else {
		report.Kept = config.ConfigDir
	}

	bin, err := os.Executable()
	if err != nil {
		return report, err
	}
	debug.Log("uninstall", "removing %s", bin)
	if err := os.Remove(bin); err != nil {
		return report, fmt.Errorf("removing %s: %w", bin, err)
	}
	report.Binary = bin
	return report, nil
}

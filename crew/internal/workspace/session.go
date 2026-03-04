package workspace

import (
	"fmt"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/exec"
)

// SessionInfo holds display data for an active crew session.
type SessionInfo struct {
	TmuxSession  string // "crew-myapp--feat-1"
	DisplayName  string // "myapp/feat-1" or "myapp"
	BaseName     string // "myapp"
	WorktreeName string // "feat-1" or ""
	IsWorktree   bool
	ProjectCount int
	DevRunning   bool
	Age          string // "2h ago", "15m ago"
}

// ListSessionInfos returns info for all active crew tmux sessions.
func ListSessionInfos() []SessionInfo {
	sessions := exec.ListCrewSessionsDetailed()
	infos := make([]SessionInfo, 0, len(sessions))

	for _, s := range sessions {
		info := parseSessionName(s.Name, formatAge(s.CreatedAt))

		// Try loading workspace for project count
		fullName := strings.TrimPrefix(s.Name, "crew-")
		if ws, err := Load(fullName); err == nil {
			info.ProjectCount = len(ws.Projects)
		}

		info.DevRunning = devRoutesExist(info.BaseName)

		infos = append(infos, info)
	}

	return infos
}

// parseSessionName builds a SessionInfo from a tmux session name and pre-formatted age string.
// It handles the "crew-" prefix and "--" worktree separator.
func parseSessionName(tmuxName, age string) SessionInfo {
	fullName := strings.TrimPrefix(tmuxName, "crew-")

	info := SessionInfo{
		TmuxSession: tmuxName,
		Age:         age,
	}

	if idx := strings.Index(fullName, "--"); idx > 0 {
		info.BaseName = fullName[:idx]
		info.WorktreeName = fullName[idx+2:]
		info.IsWorktree = true
		info.DisplayName = info.BaseName + "/" + info.WorktreeName
	} else {
		info.BaseName = fullName
		info.DisplayName = fullName
	}

	return info
}

// formatAge returns a human-readable relative duration like "2h ago", "15m ago".
func formatAge(t time.Time) string {
	d := time.Since(t)

	switch {
	case d < time.Minute:
		return "<1m ago"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}

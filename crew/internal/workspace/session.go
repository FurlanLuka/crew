package workspace

import (
	"fmt"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/exec"
)

// SessionInfo holds display data for an active crew session.
type SessionInfo struct {
	TmuxSession  string // "crew-myws"
	Workspace    string // "myws"
	ProjectCount int
	DevRunning   bool
	Age          string // "2h ago", "15m ago"
}

// ListSessionInfos returns info for all active crew tmux sessions.
func ListSessionInfos() []SessionInfo {
	sessions := exec.ListCrewSessionsDetailed()
	infos := make([]SessionInfo, 0, len(sessions))

	for _, s := range sessions {
		if s.Name == "crew-plans" || strings.HasPrefix(s.Name, "crew-dev-") {
			continue
		}

		info := parseSessionName(s.Name, formatAge(s.CreatedAt))

		if ws, err := Load(info.Workspace); err == nil {
			info.ProjectCount = len(ws.Projects)
		}

		info.DevRunning = devRoutesExist(info.Workspace)

		infos = append(infos, info)
	}

	return infos
}

// parseSessionName builds a SessionInfo from a tmux session name.
func parseSessionName(tmuxName, age string) SessionInfo {
	wsName := strings.TrimPrefix(tmuxName, "crew-")
	return SessionInfo{
		TmuxSession: tmuxName,
		Workspace:   wsName,
		Age:         age,
	}
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

package workspace

import (
	"time"

	"github.com/FurlanLuka/crew/crew/internal/dev"
)

// ServerState is one declared server as a reader shows it.
type ServerState string

const (
	ServerUp        ServerState = "up"        // runs and listens (or runs, with no port to listen on)
	ServerStarting  ServerState = "starting"  // runs, not listening yet, still inside the smoke ceiling
	ServerUnreached ServerState = "unreached" // runs, a binding points at it, nothing listens past the ceiling
	ServerQuiet     ServerState = "quiet"     // runs, nothing listens, nobody points at it — a worker
	ServerDied      ServerState = "died"      // its process is gone
	ServerStopped   ServerState = "stopped"   // not part of what runs
)

// ServerLine is one declared server: every server of the worktree, running
// or not, so a reader can draw the stopped ones too.
type ServerLine struct {
	Project string      `json:"project"`
	Server  string      `json:"server"`
	Port    int         `json:"port"`
	URL     string      `json:"url"`
	State   ServerState `json:"state"`
	// Tail is the last log lines of a server that died or never listened.
	Tail string `json:"tail,omitempty"`
}

// ServerLinesParams is what ServerLines reads: the declared servers, the
// running routes, one look at them and when the routes were written.
type ServerLinesParams struct {
	Projects  []dev.DevProject
	Routes    []dev.Route
	Checks    []SmokeResult
	Reserved  map[string]int
	StartedAt time.Time
	Now       time.Time
	URL       func(dev.Route) string
}

// ServerLines joins the declared servers with what runs. A server not in
// the routes is stopped and shows its remembered port. Pure.
func ServerLines(p ServerLinesParams) []ServerLine {
	routes := make(map[dev.ProjectServer]dev.Route, len(p.Routes))
	for _, r := range p.Routes {
		routes[dev.ProjectServer{Project: r.Project, Server: r.ServerName}] = r
	}
	checks := make(map[dev.ProjectServer]SmokeResult, len(p.Checks))
	for _, c := range p.Checks {
		checks[dev.ProjectServer{Project: c.Project, Server: c.Server}] = c
	}

	lines := []ServerLine{}
	for _, proj := range p.Projects {
		for _, ds := range proj.DevServers {
			key := dev.ProjectServer{Project: proj.Name, Server: ds.Name}
			line := ServerLine{Project: proj.Name, Server: ds.Name, Port: p.Reserved[dev.PortKey(proj.Name, ds.Name)], State: ServerStopped}
			r, running := routes[key]
			c, looked := checks[key]
			if running && looked {
				line.Port = r.InternalPort
				if p.URL != nil {
					line.URL = p.URL(r)
				}
				line.State = serverState(c, p.Now.Sub(p.StartedAt))
				if line.State == ServerDied || line.State == ServerUnreached {
					line.Tail = c.Tail
				}
			}
			lines = append(lines, line)
		}
	}
	return lines
}

// serverState reads one look's verdict, softened while the start is young:
// for deadGrace a pane whose shell has not taken the command yet reads as
// dead, and until the smoke ceiling a referenced server is unreached while
// it boots. A watch looks every half second, so it would say both.
func serverState(c SmokeResult, age time.Duration) ServerState {
	switch c.State() {
	case SmokeOK:
		return ServerUp
	case SmokeDied:
		if age < deadGrace {
			return ServerStarting
		}
		return ServerDied
	case SmokeIdle:
		return ServerQuiet
	}
	if age < SmokeCeiling {
		return ServerStarting
	}
	return ServerUnreached
}

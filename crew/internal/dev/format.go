package dev

import (
	"fmt"
	"sort"
	"strings"
)

// GroupResolutions buckets resolutions by project, preserving their order.
func GroupResolutions(resolutions []Resolution) map[string][]Resolution {
	byProject := make(map[string][]Resolution)
	for _, r := range resolutions {
		byProject[r.Project] = append(byProject[r.Project], r)
	}
	return byProject
}

// InspectEnvConflicts reads each project's env files and reports values aimed
// at a port crew handed to a server in another worktree.
func InspectEnvConflicts(slug Slug, projects []DevProject, planned []PlannedServer, resolutions []Resolution) []Conflict {
	allocated := AllocatedPorts()

	var conflicts []Conflict
	for _, p := range projects {
		conflicts = append(conflicts, DetectPortConflicts(DetectParams{
			Project:   p.Name,
			Slug:      slug,
			EnvValues: ReadEnvValues(p.Path),
			Injected:  injectedEverywhere(resolutions, p),
			Allocated: allocated,
			Siblings:  planned,
		})...)
	}
	return conflicts
}

// injectedEverywhere is the rows every server of the project gets, resolved
// — a var scoped to one server, or unresolved for one, still reaches the
// others from the env file, so its file value is not harmless there. A
// project with no servers gets its project-wide rows. Pure.
func injectedEverywhere(resolutions []Resolution, p DevProject) []Resolution {
	if len(p.DevServers) == 0 {
		return EnvFor(resolutions, ProjectServer{Project: p.Name})
	}
	count := map[string]int{}
	var first []Resolution
	for i, ds := range p.DevServers {
		rows := EnvFor(resolutions, ProjectServer{Project: p.Name, Server: ds.Name})
		if i == 0 {
			first = rows
		}
		seen := map[string]bool{}
		for _, r := range rows {
			if r.Resolved() && !seen[r.Var] {
				seen[r.Var] = true
				count[r.Var]++
			}
		}
	}
	var out []Resolution
	emitted := map[string]bool{}
	for _, r := range first {
		if r.Resolved() && count[r.Var] == len(p.DevServers) && !emitted[r.Var] {
			emitted[r.Var] = true
			out = append(out, r)
		}
	}
	return out
}

// FormatResolutions renders the start-time summary. Pure.
//
// Anomalies print in full; successes collapse to a count. A wall of correct
// lines on every start is where a wrong line hides, which is the failure this
// whole feature exists to prevent — reproduced by the display of the fix. The
// full table is one `crew env` away.
func FormatResolutions(resolutions []Resolution) string {
	if len(resolutions) == 0 {
		return ""
	}

	resolved := 0
	unresolved := make(map[string][]Resolution)
	var order []string
	for _, r := range resolutions {
		if r.Resolved() {
			resolved++
			continue
		}
		if _, seen := unresolved[r.Project]; !seen {
			order = append(order, r.Project)
		}
		unresolved[r.Project] = append(unresolved[r.Project], r)
	}

	var b strings.Builder
	fmt.Fprintf(&b, "Resolved env  %s across %s\n",
		plural(resolved, "var", "vars"), plural(countProjects(resolutions), "project", "projects"))

	for _, projName := range order {
		fmt.Fprintf(&b, "\n  %s\n", projName)
		width := varWidth(unresolved[projName])
		for _, r := range unresolved[projName] {
			fmt.Fprintf(&b, "    %-*s  left alone — %s\n", width, r.Label(), r.Detail)
		}
	}
	return b.String()
}

// FormatAnomalies is FormatResolutions without the count line — just what was
// left alone, for a page that shows the servers themselves right above.
func FormatAnomalies(resolutions []Resolution) string {
	unresolved := make(map[string][]Resolution)
	var order []string
	for _, r := range resolutions {
		if r.Resolved() {
			continue
		}
		if _, seen := unresolved[r.Project]; !seen {
			order = append(order, r.Project)
		}
		unresolved[r.Project] = append(unresolved[r.Project], r)
	}
	if len(order) == 0 {
		return ""
	}

	var b strings.Builder
	for _, projName := range order {
		fmt.Fprintf(&b, "\n  %s\n", projName)
		width := varWidth(unresolved[projName])
		for _, r := range unresolved[projName] {
			fmt.Fprintf(&b, "    %-*s  left alone — %s\n", width, r.Label(), r.Detail)
		}
	}
	return b.String()
}

// FormatConflicts renders the port-conflict warnings. Pure.
func FormatConflicts(conflicts []Conflict) string {
	if len(conflicts) == 0 {
		return ""
	}

	var b strings.Builder
	for _, c := range conflicts {
		fmt.Fprintf(&b, "\n  ! %s/.env: %s=%s\n", c.Project, c.Var, c.Value)
		if c.Stale != nil {
			fmt.Fprintf(&b, "    :%d is %s/%s's configured port, but it is running on :%d — crew add binding %s --scan\n",
				c.Port, c.Stale.Project, c.Stale.Server, c.Stale.ActualPort, c.Project)
			continue
		}
		fmt.Fprintf(&b, "    :%d is %s/%s in worktree %s\n",
			c.Port, c.Owner.Project, c.Owner.Server, DisplayRef(c.Owner.Slug))
	}
	return b.String()
}

// FormatEnvTable renders the full per-project table behind `crew env`.
func FormatEnvTable(resolutions []Resolution) string {
	if len(resolutions) == 0 {
		return ""
	}

	width := varWidth(resolutions)
	var b strings.Builder
	for _, r := range resolutions {
		if r.Resolved() {
			fmt.Fprintf(&b, "  %-*s  %s\n", width, r.Label(), r.Value)
			continue
		}
		fmt.Fprintf(&b, "  %-*s  left alone — %s\n", width, r.Label(), r.Detail)
	}
	return b.String()
}

// EnvLines renders resolved variables as KEY=VALUE, for `crew env` stdout.
// Only resolved variables appear: an unresolved one is precisely a variable
// crew is not setting.
func EnvLines(resolutions []Resolution) []string {
	var lines []string
	for _, r := range resolutions {
		if r.Resolved() {
			lines = append(lines, r.Var+"="+r.Value)
		}
	}
	sort.Strings(lines)
	return lines
}

// varWidth is the label column: a scoped row's "(server)" counts.
func varWidth(resolutions []Resolution) int {
	width := 0
	for _, r := range resolutions {
		if n := len([]rune(r.Label())); n > width {
			width = n
		}
	}
	return width
}

// ScopedServers names the servers any of a project's rows are scoped to —
// the env table's trailer says how to see one server's set.
func ScopedServers(resolutions []Resolution) []string {
	var out []string
	seen := map[string]bool{}
	for _, r := range resolutions {
		if r.Server != "" && !seen[r.Server] {
			seen[r.Server] = true
			out = append(out, r.Server)
		}
	}
	return out
}

func countProjects(resolutions []Resolution) int {
	seen := make(map[string]bool)
	for _, r := range resolutions {
		seen[r.Project] = true
	}
	return len(seen)
}

func plural(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, one)
	}
	return fmt.Sprintf("%d %s", n, many)
}

// StatusRow is one running dev server as `crew dev status` reports it.
type StatusRow struct {
	Worktree     string `json:"worktree"`
	ServerName   string `json:"server_name"`
	ExternalPort int    `json:"external_port"`
	URL          string `json:"url"`
}

// StatusRows flattens route files into display rows. Pure.
func StatusRows(all []WsRoutes, domain string, proxyPort int) []StatusRow {
	rows := []StatusRow{}
	for _, wr := range all {
		for _, r := range wr.Routes {
			rows = append(rows, StatusRow{
				Worktree:     DisplayRef(wr.Slug),
				ServerName:   r.ServerName,
				ExternalPort: r.ExternalPort,
				URL:          RouteURL(r, wr.Slug, domain, proxyPort),
			})
		}
	}
	return rows
}

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
func InspectEnvConflicts(slug Slug, projects []DevProject, resolutions []Resolution) []Conflict {
	allocated := AllocatedPorts()
	byProject := GroupResolutions(resolutions)

	var conflicts []Conflict
	for _, p := range projects {
		conflicts = append(conflicts, DetectPortConflicts(DetectParams{
			Project:   p.Name,
			Slug:      slug,
			EnvValues: ReadEnvValues(p.Path),
			Injected:  byProject[p.Name],
			Allocated: allocated,
		})...)
	}
	return conflicts
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
			fmt.Fprintf(&b, "    %-*s  left alone — %s\n", width, r.Var, r.Detail)
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
			fmt.Fprintf(&b, "  %-*s  %s\n", width, r.Var, r.Value)
			continue
		}
		fmt.Fprintf(&b, "  %-*s  left alone — %s\n", width, r.Var, r.Detail)
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

func varWidth(resolutions []Resolution) int {
	width := 0
	for _, r := range resolutions {
		if len(r.Var) > width {
			width = len(r.Var)
		}
	}
	return width
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

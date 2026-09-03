package procs

import (
	"fmt"
	"os/exec"
	"sort"
	"strconv"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/debug"
	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"
)

// sessionPrefix matches every tmux session crew creates: crew-dev-<ws>,
// and crew-dev-proxy.
const sessionPrefix = "crew-"

// collectSessions groups crew's tmux sessions with the processes running in
// them, so those pids are not also reported as loose.
func collectSessions(rows []crewExec.ProcRow) []Session {
	panes, err := listCrewPanes()
	if err != nil || len(panes) == 0 {
		return nil
	}

	children := map[int][]int{}
	for _, r := range rows {
		children[r.PPID] = append(children[r.PPID], r.PID)
	}

	command := make(map[int]string, len(rows))
	for _, r := range rows {
		command[r.PID] = r.Command
	}

	byName := map[string][]Proc{}
	for session, panePIDs := range panes {
		seen := map[int]bool{}
		for _, pid := range panePIDs {
			for frontier := []int{pid}; len(frontier) > 0; {
				cur := frontier[0]
				frontier = frontier[1:]
				if seen[cur] {
					continue
				}
				seen[cur] = true
				byName[session] = append(byName[session], Proc{PID: cur, Command: command[cur]})
				frontier = append(frontier, children[cur]...)
			}
		}
	}

	sessions := make([]Session, 0, len(byName))
	for name, procs := range byName {
		sortProcs(procs)
		sessions = append(sessions, Session{Name: name, Procs: procs})
	}
	sort.Slice(sessions, func(i, j int) bool { return sessions[i].Name < sessions[j].Name })
	return sessions
}

// listCrewPanes maps each crew tmux session to its pane pids. A missing tmux
// server is not an error — it means nothing is running.
func listCrewPanes() (map[string][]int, error) {
	args := []string{"list-panes", "-a", "-F", "#{session_name} #{pane_pid}"}
	debug.Log("procs", "tmux %s", strings.Join(args, " "))
	out, err := exec.Command("tmux", args...).Output()
	if err != nil {
		debug.Log("procs", "tmux list-panes → %v (no server?)", err)
		return nil, err
	}

	panes := map[string][]int{}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 || !strings.HasPrefix(fields[0], sessionPrefix) {
			continue
		}
		if pid, err := strconv.Atoi(fields[1]); err == nil && pid > 0 {
			panes[fields[0]] = append(panes[fields[0]], pid)
		}
	}
	return panes, nil
}

// processCWDs maps pid to working directory.
//
// lsof is the only way to read another process's cwd on macOS — there is no
// /proc. It exits 0 even when it cannot inspect every process (root-owned ones
// are silently omitted), so a successful call means "scanned", never
// "complete".
func processCWDs() (map[int]string, error) {
	args := []string{"-a", "-d", "cwd", "-Fpn"}
	debug.Log("procs", "lsof %s", strings.Join(args, " "))
	out, err := exec.Command("lsof", args...).Output()
	if err != nil && len(out) == 0 {
		debug.Log("procs", "lsof → error: %v", err)
		return nil, err
	}

	cwds := parseCWDs(string(out))
	if len(cwds) == 0 {
		return nil, fmt.Errorf("lsof returned no readable working directories")
	}
	return cwds, nil
}

// parseCWDs reads `lsof -Fpn` output.
//
// Records are p/f/n triplets, not p/n pairs — lsof emits the fd line as a set
// delimiter even though only p and n were requested:
//
//	p91036
//	fcwd
//	n/Users/luka/Documents/crew
//
// A process whose directory could not be read yields a p line with no n line.
// Its path must be dropped rather than paired with the next record's, or a
// process inherits someone else's directory and becomes a false orphan.
func parseCWDs(out string) map[int]string {
	cwds := map[int]string{}
	pid := 0
	for _, line := range strings.Split(out, "\n") {
		if len(line) < 2 {
			continue
		}
		switch line[0] {
		case 'p':
			pid = 0
			if n, err := strconv.Atoi(line[1:]); err == nil && n > 0 {
				pid = n
			}
		case 'n':
			if pid > 0 {
				cwds[pid] = line[1:]
				pid = 0
			}
		}
	}
	return cwds
}

// maxProcsPerUID reports the per-user process ceiling, the limit crew's leaks
// used to exhaust. Zero means unknown, and callers omit the ratio.
func maxProcsPerUID() int {
	out, err := exec.Command("sysctl", "-n", "kern.maxprocperuid").Output()
	if err != nil {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil {
		return 0
	}
	return n
}

func sortProcs(procs []Proc) {
	sort.Slice(procs, func(i, j int) bool { return procs[i].PID < procs[j].PID })
}

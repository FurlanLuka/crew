package workspace

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	crewExec "github.com/FurlanLuka/crew/crew/internal/exec"
)

// launchMarker is the first line of a launch.json crew wrote; a file
// without it is someone's own and crew leaves it alone.
const launchMarker = "// written by crew — url-only entries point Claude Desktop's preview at crew's dev servers"

// DesktopSession is the tmux session `claude --desktop` runs in: it needs a
// terminal, and the page calls crew without one.
const DesktopSession = "crew-desktop"

// DesktopFolder is the folder Claude Desktop opens for a worktree: a single
// project's checkout, so its CLAUDE.md and .claude settings load as they do
// in the terminal launch; with several projects the worktree root, since
// Desktop takes one folder and has no --add-dir. Pure.
func DesktopFolder(res *Resolved) string {
	if len(res.Projects) == 1 {
		return res.Projects[0].Path
	}
	return res.Dir
}

// LaunchServer is one entry of Desktop's launch.json.
type LaunchServer struct {
	Name string
	Port int
}

// LaunchServers is every listening server of the worktree with its port:
// the running one when it runs, else the remembered one. Pure.
func LaunchServers(res *Resolved, routes []dev.Route) []LaunchServer {
	running := dev.IndexRoutePorts(routes)
	var out []LaunchServer
	for _, p := range res.Projects {
		for _, ds := range p.DevServers {
			if !ds.Listens() {
				continue
			}
			port := running[dev.ProjectServer{Project: p.Name, Server: ds.Name}]
			if port == 0 {
				port = res.Ports[dev.PortKey(p.Name, ds.Name)]
			}
			if port == 0 {
				continue
			}
			out = append(out, LaunchServer{Name: dev.PortKey(p.Name, ds.Name), Port: port})
		}
	}
	return out
}

// LaunchConfig is Desktop's .claude/launch.json for crew's servers: url-only
// entries, so the preview attaches to a running server instead of starting
// its own on another port. Nil when there is nothing to point at. Pure.
func LaunchConfig(servers []LaunchServer) []byte {
	if len(servers) == 0 {
		return nil
	}
	type entry struct {
		Name string `json:"name"`
		URL  string `json:"url"`
	}
	doc := struct {
		Version        string  `json:"version"`
		Configurations []entry `json:"configurations"`
	}{Version: "0.0.1"}
	for _, s := range servers {
		doc.Configurations = append(doc.Configurations, entry{Name: s.Name, URL: fmt.Sprintf("http://localhost:%d", s.Port)})
	}
	data, _ := json.MarshalIndent(doc, "", "  ")
	return append([]byte(launchMarker+"\n"), append(data, '\n')...)
}

// launchConfigWritable: crew writes a launch.json that is absent or its own.
func launchConfigWritable(existing []byte, exists bool) bool {
	return !exists || bytes.HasPrefix(existing, []byte(launchMarker))
}

// WriteLaunchConfig writes the worktree's launch.json into the Desktop
// folder, and returns a warning line when someone else's file is in the way.
func WriteLaunchConfig(res *Resolved) (string, error) {
	path := launchConfigPath(res)
	existing, err := os.ReadFile(path)
	if exists := err == nil; !launchConfigWritable(existing, exists) {
		return fmt.Sprintf("%s is not crew's — left as it is; Desktop's preview may start its own servers", path), nil
	}
	return "", writeLaunch(res, path, existing)
}

// RefreshLaunchConfig rewrites the launch.json crew already wrote and
// creates none — what a dev start does, so its ports never go stale.
func RefreshLaunchConfig(res *Resolved) error {
	path := launchConfigPath(res)
	existing, err := os.ReadFile(path)
	if err != nil || !launchConfigWritable(existing, true) {
		return nil
	}
	return writeLaunch(res, path, existing)
}

func launchConfigPath(res *Resolved) string {
	return filepath.Join(DesktopFolder(res), ".claude", "launch.json")
}

func writeLaunch(res *Resolved, path string, existing []byte) error {
	routes, _ := dev.LoadRoutes(res.Slug)
	data := LaunchConfig(LaunchServers(res, routes))
	if data == nil || bytes.Equal(existing, data) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	debug.Log("dev", "write %s", path)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return err
	}
	excludeFromGit(DesktopFolder(res), ".claude/launch.json")
	return nil
}

// excludeFromGit keeps crew's file out of a checkout's git status, through
// the repo's own info/exclude (a linked worktree's common one), never
// .gitignore. Only when the folder is the repo's top: a worktree root is
// not a repo, and git would walk up to whatever is above it — a dotfiles
// repo in $HOME, say.
func excludeFromGit(dir, entry string) {
	exclude, ok := crewExec.GitExcludeFile(dir)
	if !ok {
		return
	}
	data, _ := os.ReadFile(exclude)
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == entry {
			return
		}
	}
	debug.Log("git", "add %s to %s", entry, exclude)
	if err := os.MkdirAll(filepath.Dir(exclude), 0o755); err != nil {
		debug.Log("git", "%s: %v", exclude, err)
		return
	}
	add := entry + "\n"
	if len(data) > 0 && !bytes.HasSuffix(data, []byte("\n")) {
		add = "\n" + add
	}
	f, err := os.OpenFile(exclude, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		debug.Log("git", "%s: %v", exclude, err)
		return
	}
	defer f.Close()
	if _, err := f.WriteString(add); err != nil {
		debug.Log("git", "%s: %v", exclude, err)
	}
}

// DesktopCommand is the line tmux runs: HOME and CLAUDE_CONFIG_DIR set
// explicitly and claude by absolute path, since the tmux server's
// environment is not the caller's — and CREW_REF unset, which a caller in
// another worktree's session would hand on to a Desktop it starts. Pure.
func DesktopCommand(claudeBin, home, configDir string) string {
	parts := []string{"env", "-u", "CREW_REF", "HOME=" + crewExec.ShellQuote(home)}
	if configDir != "" {
		parts = append(parts, "CLAUDE_CONFIG_DIR="+crewExec.ShellQuote(configDir))
	}
	parts = append(parts, crewExec.ShellQuote(claudeBin), "--desktop")
	return strings.Join(parts, " ")
}

// DesktopAvailable: this machine can open Claude Desktop — macOS with the
// app installed. Only then does the page offer to open a worktree here.
func DesktopAvailable() bool {
	if runtime.GOOS != "darwin" {
		return false
	}
	for _, dir := range []string{"/Applications", filepath.Join(os.Getenv("HOME"), "Applications")} {
		if _, err := os.Stat(filepath.Join(dir, "Claude.app")); err == nil {
			return true
		}
	}
	return false
}

// OpenInDesktop opens a worktree in Claude Desktop on this machine.
func OpenInDesktop(res *Resolved, claudeBin string) (string, error) {
	if !DesktopAvailable() {
		return "", fmt.Errorf("Claude Desktop isn't installed on this machine — open the worktree from Desktop over SSH instead")
	}
	warning, err := WriteLaunchConfig(res)
	if err != nil {
		return "", err
	}
	home, _ := os.UserHomeDir()
	folder := DesktopFolder(res)
	return warning, crewExec.TmuxRunInSession(DesktopSession, string(res.Slug), folder, DesktopCommand(claudeBin, home, config.ClaudeConfigOverride()))
}

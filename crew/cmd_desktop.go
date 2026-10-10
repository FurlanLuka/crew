package main

import (
	"fmt"
	"os"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/release"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// MinPluginVersion is the crew plugin release that ships the pane; a test
// keeps .claude-plugin/plugin.json at or above it.
const MinPluginVersion = "6.6.0"

// MinClaudeVersion is the first Claude Code that loads mods.
const MinClaudeVersion = "2.1.287"

// pluginState is what the plugin check found.
type pluginState int

const (
	pluginOK pluginState = iota
	pluginMissing
	pluginDisabled
	pluginOld
	claudeOld
)

// desktopOutput is `crew claude <ref> --desktop --json`.
type desktopOutput struct {
	Ref    string `json:"ref"`
	Folder string `json:"folder"`
}

// pluginStatus reads `claude plugin list --json` and `claude --version`
// for what the pane needs. Installed at several scopes, an enabled entry
// wins. An unparseable version passes: crew only warns about what it knows.
// Pure.
func pluginStatus(list []exec.InstalledPlugin, claudeVersion string) (pluginState, string) {
	if release.IsNewer(MinClaudeVersion, claudeVersion) {
		return claudeOld, claudeVersion
	}
	found, enabled, enabledVersion := false, false, ""
	for _, p := range list {
		if p.ID != "crew@crew" {
			continue
		}
		found = true
		if p.Enabled && (!enabled || release.IsNewer(p.Version, enabledVersion)) {
			enabled, enabledVersion = true, p.Version
		}
	}
	switch {
	case !found:
		return pluginMissing, ""
	case !enabled:
		return pluginDisabled, ""
	case release.IsNewer(MinPluginVersion, enabledVersion):
		return pluginOld, enabledVersion
	}
	return pluginOK, enabledVersion
}

// pluginLine is the one warning line for a state, or "" when all is well.
// Pure.
func pluginLine(st pluginState, version string) string {
	switch st {
	case claudeOld:
		return fmt.Sprintf("! Claude Code %s can't show the crew pane (needs %s) — claude update", version, MinClaudeVersion)
	case pluginMissing:
		return "! crew's Claude Code plugin isn't installed, so the session gets no crew pane — claude plugin install crew@crew"
	case pluginDisabled:
		return "! crew's Claude Code plugin is disabled, so the session gets no crew pane — claude plugin enable crew@crew"
	case pluginOld:
		return fmt.Sprintf("! crew's Claude Code plugin is %s; the crew pane needs %s — claude plugin update crew@crew", version, MinPluginVersion)
	}
	return ""
}

// checkPlugin warns, never blocks: the launch goes ahead either way.
func checkPlugin(claudeBin string) string {
	list, err := exec.ClaudePlugins(claudeBin, config.ClaudeConfigOverride())
	if err != nil {
		debug.Log("claude", "plugin check: %v", err)
		return "! couldn't check crew's Claude Code plugin — the crew pane needs it (claude plugin list)"
	}
	version, _ := exec.ClaudeVersion(claudeBin)
	return pluginLine(pluginStatus(list, version))
}

// cmdClaudeDesktop is `crew claude <ref> --desktop`: no terminal needed —
// the page calls it — and nothing replaces this process.
func cmdClaudeDesktop(refArg string) {
	res := mustResolve(refArg)
	if !workspace.DesktopAvailable() {
		fmt.Fprintf(os.Stderr, "Error: Claude Desktop isn't installed on this machine — open the worktree from Desktop over SSH instead\n")
		os.Exit(1)
	}
	claudeBin := exec.ClaudeBinary()
	if claudeBin == "" {
		fmt.Fprintf(os.Stderr, "Error: claude not found on PATH — install Claude Code first\n")
		os.Exit(1)
	}
	if line := checkPlugin(claudeBin); line != "" {
		fmt.Fprintln(human, line)
	}
	warning, err := workspace.OpenInDesktop(res, claudeBin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if warning != "" {
		fmt.Fprintf(human, "! %s\n", warning)
	}
	if jsonOutput {
		printJSON(desktopOutput{Ref: res.Ref.String(), Folder: workspace.DesktopFolder(res)})
		return
	}
	fmt.Printf("Opened %s in Claude Desktop (%s)\n", res.Ref, workspace.DesktopFolder(res))
}

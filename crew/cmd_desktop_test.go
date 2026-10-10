package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/release"
)

func TestPluginStatus(t *testing.T) {
	crew := func(version string, enabled bool, scope string) exec.InstalledPlugin {
		return exec.InstalledPlugin{ID: "crew@crew", Version: version, Enabled: enabled, Scope: scope}
	}
	other := exec.InstalledPlugin{ID: "proxy@proxy-marketplace", Version: "9.0.0", Enabled: true}
	cases := []struct {
		name    string
		list    []exec.InstalledPlugin
		claude  string
		want    pluginState
		version string
	}{
		{"current", []exec.InstalledPlugin{other, crew("6.6.0", true, "user")}, "2.1.295", pluginOK, "6.6.0"},
		{"newer, compared as numbers", []exec.InstalledPlugin{crew("6.10.0", true, "user")}, "2.1.295", pluginOK, "6.10.0"},
		{"old", []exec.InstalledPlugin{crew("6.5.1", true, "user")}, "2.1.295", pluginOld, "6.5.1"},
		{"missing", []exec.InstalledPlugin{other}, "2.1.295", pluginMissing, ""},
		{"disabled", []exec.InstalledPlugin{crew("6.6.0", false, "user")}, "2.1.295", pluginDisabled, ""},
		{"enabled scope wins", []exec.InstalledPlugin{crew("6.7.0", false, "user"), crew("6.6.0", true, "project")}, "2.1.295", pluginOK, "6.6.0"},
		{"newest enabled scope", []exec.InstalledPlugin{crew("6.6.0", true, "project"), crew("6.8.0", true, "user")}, "2.1.295", pluginOK, "6.8.0"},
		{"enabled with no version is enabled", []exec.InstalledPlugin{crew("", true, "user")}, "2.1.295", pluginOK, ""},
		{"old Claude Code", []exec.InstalledPlugin{crew("6.6.0", true, "user")}, "2.1.282", claudeOld, "2.1.282"},
		{"unparseable versions pass", []exec.InstalledPlugin{crew("dev", true, "user")}, "", pluginOK, "dev"},
	}
	for _, c := range cases {
		got, version := pluginStatus(c.list, c.claude)
		if got != c.want || version != c.version {
			t.Errorf("%s: %v %q, want %v %q", c.name, got, version, c.want, c.version)
		}
	}
}

func TestPluginLine(t *testing.T) {
	if pluginLine(pluginOK, "6.6.0") != "" {
		t.Error("ok → no line")
	}
	if got := pluginLine(pluginOld, "6.0.0"); !strings.Contains(got, "6.0.0") || !strings.Contains(got, "claude plugin update crew@crew") {
		t.Errorf("old → %q", got)
	}
	if got := pluginLine(pluginMissing, ""); !strings.Contains(got, "claude plugin install crew@crew") {
		t.Errorf("missing → %q", got)
	}
}

// A release that forgets to bump the plugin would warn on every launch.
func TestPluginManifestMeetsMinimum(t *testing.T) {
	data, err := os.ReadFile("../.claude-plugin/plugin.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	// IsNewer is quiet about a version it cannot read; one that parses is
	// part of the promise.
	if !release.IsNewer(manifest.Version, "0.0.0") || release.IsNewer(MinPluginVersion, manifest.Version) {
		t.Errorf("plugin.json is %s, below MinPluginVersion %s", manifest.Version, MinPluginVersion)
	}
}

// The shape Claude Code 2.1.295 prints, trimmed from a real run.
func TestParsePlugins(t *testing.T) {
	out := `[
  {"id": "crew@crew", "version": "2.4.2", "scope": "user", "enabled": true, "installPath": "/Users/dev/.claude/plugins/cache/crew/crew/2.4.2", "installedAt": "2026-09-21T14:50:24.701Z", "lastUpdated": "2026-09-21T19:21:27.035Z", "projectEnabled": false},
  {"id": "crew@crew", "version": "2.4.2", "scope": "project", "enabled": true, "installPath": "/x", "projectPath": "/private/tmp/ob/home", "projectEnabled": false}
]`
	list, err := exec.ParsePlugins([]byte(out))
	if err != nil || len(list) != 2 || list[0].ID != "crew@crew" || list[0].Version != "2.4.2" || !list[0].Enabled || list[1].Scope != "project" {
		t.Errorf("parsed %+v, %v", list, err)
	}
	if st, v := pluginStatus(list, "2.1.295"); st != pluginOld || v != "2.4.2" {
		t.Errorf("that machine → %v %q, want old 2.4.2", st, v)
	}
	if _, err := exec.ParsePlugins([]byte("not json")); err == nil {
		t.Error("garbage → error")
	}
}

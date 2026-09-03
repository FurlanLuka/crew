package help

import (
	"testing"
)

func TestRootHasSubcommands(t *testing.T) {
	if len(Root.Subcommands) == 0 {
		t.Fatal("Root.Subcommands is empty")
	}
}

func TestFindSubcommand(t *testing.T) {
	tests := []struct {
		name  string
		found bool
	}{
		{"workspace", true},
		{"project", true},
		{"add", true},
		{"dev", true},
		{"ls", true},
		{"help", true},
		{"launch", true},
		{"code", true},
		{"config", true},
		{"nonexistent", false},
		{"", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := findSubcommand(&Root, tt.name)
			if tt.found && result == nil {
				t.Errorf("findSubcommand(%q) = nil, want non-nil", tt.name)
			}
			if !tt.found && result != nil {
				t.Errorf("findSubcommand(%q) = %+v, want nil", tt.name, result)
			}
		})
	}
}

func TestDevSubcommands(t *testing.T) {
	dev := findSubcommand(&Root, "dev")
	if dev == nil {
		t.Fatal("dev command not found")
	}

	expected := []string{"setup", "add", "rm", "show", "start", "stop", "restart", "status", "logs", "tui"}
	if len(dev.Subcommands) != len(expected) {
		t.Fatalf("dev has %d subcommands, want %d", len(dev.Subcommands), len(expected))
	}

	for _, name := range expected {
		if findSubcommand(dev, name) == nil {
			t.Errorf("dev subcommand %q not found", name)
		}
	}
}

func TestLsSubcommands(t *testing.T) {
	ls := findSubcommand(&Root, "ls")
	if ls == nil {
		t.Fatal("ls command not found")
	}

	expected := []string{"workspaces", "worktrees", "projects", "bindings", "overrides"}
	for _, name := range expected {
		if findSubcommand(ls, name) == nil {
			t.Errorf("ls subcommand %q not found", name)
		}
	}
}

func TestRmCommand(t *testing.T) {
	rm := findSubcommand(&Root, "rm")
	if rm == nil {
		t.Fatal("rm command not found")
	}

	if rm.Usage != "crew rm <workspace>" {
		t.Errorf("rm Usage = %q, want %q", rm.Usage, "crew rm <workspace>")
	}

	expected := []string{"project", "workspace"}
	for _, name := range expected {
		if findSubcommand(rm, name) == nil {
			t.Errorf("rm subcommand %q not found", name)
		}
	}

	proj := findSubcommand(rm, "project")
	if proj.Usage == "" {
		t.Error("rm project missing usage")
	}

	ws := findSubcommand(rm, "workspace")
	if ws.Usage == "" {
		t.Error("rm workspace missing usage")
	}
}

func TestAddSubcommands(t *testing.T) {
	add := findSubcommand(&Root, "add")
	if add == nil {
		t.Fatal("add command not found")
	}

	expected := []string{"project", "workspace", "worktree", "binding", "override"}
	for _, name := range expected {
		if findSubcommand(add, name) == nil {
			t.Errorf("add subcommand %q not found", name)
		}
	}

	proj := findSubcommand(add, "project")
	if proj.Usage == "" {
		t.Error("add project missing usage")
	}

	ws := findSubcommand(add, "workspace")
	if ws.Usage == "" {
		t.Error("add workspace missing usage")
	}
	if len(ws.Flags) != 2 {
		t.Fatalf("add workspace should have 2 flags, got %d", len(ws.Flags))
	}
	wantFlags := map[string]bool{"--role=<r>": true, "--direct": true}
	for _, f := range ws.Flags {
		if !wantFlags[f.Name] {
			t.Errorf("unexpected flag %q on add workspace", f.Name)
		}
	}
}

func TestConfigSubcommands(t *testing.T) {
	cfg := findSubcommand(&Root, "config")
	if cfg == nil {
		t.Fatal("config command not found")
	}

	expected := []string{"show", "set"}
	for _, name := range expected {
		sub := findSubcommand(cfg, name)
		if sub == nil {
			t.Errorf("config subcommand %q not found", name)
		}
		if sub.Usage == "" {
			t.Errorf("config %s missing usage", name)
		}
	}

	show := findSubcommand(cfg, "show")
	if show.OutputFormat == "" {
		t.Error("config show missing output format")
	}
}

func TestExamplesPresent(t *testing.T) {
	// Commands that should have examples
	cmdsWithExamples := []struct {
		path []string
	}{
		{[]string{"add", "project"}},
		{[]string{"add", "workspace"}},
		{[]string{"config", "set"}},
		{[]string{"dev", "add"}},
		{[]string{"dev", "start"}},
		{[]string{"rm"}},
		{[]string{"rm", "project"}},
		{[]string{"rm", "workspace"}},
		{[]string{"help"}},
	}

	for _, tt := range cmdsWithExamples {
		cmd := &Root
		for _, name := range tt.path {
			cmd = findSubcommand(cmd, name)
			if cmd == nil {
				t.Errorf("command %v not found", tt.path)
				break
			}
		}
		if cmd != nil && len(cmd.Examples) == 0 {
			t.Errorf("command %v should have examples", tt.path)
		}
	}
}

func TestRmSubcommands(t *testing.T) {
	rm := findSubcommand(&Root, "rm")
	if rm == nil {
		t.Fatal("rm command not found")
	}

	for _, name := range []string{"project", "workspace", "worktree", "binding", "override"} {
		if findSubcommand(rm, name) == nil {
			t.Errorf("rm subcommand %q not found", name)
		}
	}
}

// Every top-level command main dispatches must be documented, or `crew help`
// lies about what exists.
func TestTopLevelCommandsDocumented(t *testing.T) {
	for _, name := range []string{"env", "run", "migrate", "duplicate", "add", "rm", "ls", "dev"} {
		if findSubcommand(&Root, name) == nil {
			t.Errorf("top-level command %q not documented", name)
		}
	}
}

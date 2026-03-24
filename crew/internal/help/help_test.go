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
		{"registry", true},
		{"dev", true},
		{"ls", true},
		{"help", true},
		{"launch", true},
		{"code", true},
		{"plans", true},
		{"config", true},
		{"profile", true},
		{"notify", true},
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

	expected := []string{"setup", "add", "rm", "show", "start", "stop", "restart", "status"}
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

	expected := []string{"workspaces", "projects"}
	for _, name := range expected {
		if findSubcommand(ls, name) == nil {
			t.Errorf("ls subcommand %q not found", name)
		}
	}
}

func TestRegistrySubcommands(t *testing.T) {
	reg := findSubcommand(&Root, "registry")
	if reg == nil {
		t.Fatal("registry command not found")
	}

	expected := []string{"install", "rm", "update"}
	for _, name := range expected {
		if findSubcommand(reg, name) == nil {
			t.Errorf("registry subcommand %q not found", name)
		}
	}

	install := findSubcommand(reg, "install")
	if install.Usage == "" {
		t.Error("registry install missing usage")
	}
	if len(install.Flags) != 1 || install.Flags[0].Name != "--all" {
		t.Error("registry install should have --all flag")
	}

	update := findSubcommand(reg, "update")
	if update.Usage == "" {
		t.Error("registry update missing usage")
	}
	if len(update.Flags) != 1 || update.Flags[0].Name != "--all" {
		t.Error("registry update should have --all flag")
	}

	rm := findSubcommand(reg, "rm")
	if rm.Usage == "" {
		t.Error("registry rm missing usage")
	}
}

func TestPlansSubcommands(t *testing.T) {
	plans := findSubcommand(&Root, "plans")
	if plans == nil {
		t.Fatal("plans command not found")
	}

	expected := []string{"start", "stop"}
	for _, name := range expected {
		if findSubcommand(plans, name) == nil {
			t.Errorf("plans subcommand %q not found", name)
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

	expected := []string{"project", "workspace"}
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
	if len(ws.Flags) != 1 || ws.Flags[0].Name != "--role=<r>" {
		t.Error("add workspace should have --role flag")
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

func TestProfileSubcommands(t *testing.T) {
	prof := findSubcommand(&Root, "profile")
	if prof == nil {
		t.Fatal("profile command not found")
	}

	expected := []string{"install", "update", "rm", "status"}
	for _, name := range expected {
		sub := findSubcommand(prof, name)
		if sub == nil {
			t.Errorf("profile subcommand %q not found", name)
		}
		if sub.Usage == "" {
			t.Errorf("profile %s missing usage", name)
		}
	}
}

func TestExamplesPresent(t *testing.T) {
	// Commands that should have examples
	cmdsWithExamples := []struct {
		path []string
	}{
		{[]string{"add", "project"}},
		{[]string{"add", "workspace"}},
		{[]string{"registry", "install"}},
		{[]string{"registry", "rm"}},
		{[]string{"registry", "update"}},
		{[]string{"config", "set"}},
		{[]string{"notify", "setup"}},
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

func TestNotifySubcommands(t *testing.T) {
	notify := findSubcommand(&Root, "notify")
	if notify == nil {
		t.Fatal("notify command not found")
	}

	expected := []string{"setup", "test", "rm"}
	for _, name := range expected {
		sub := findSubcommand(notify, name)
		if sub == nil {
			t.Errorf("notify subcommand %q not found", name)
		}
		if sub.Usage == "" {
			t.Errorf("notify %s missing usage", name)
		}
	}
}

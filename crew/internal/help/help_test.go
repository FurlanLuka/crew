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
		{"registry", true},
		{"dev", true},
		{"ls", true},
		{"help", true},
		{"launch", true},
		{"code", true},
		{"plans", true},
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

	expected := []string{"workspaces", "projects", "sessions"}
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

	install := findSubcommand(reg, "install")
	if install == nil {
		t.Fatal("registry install subcommand not found")
	}

	if install.Usage == "" {
		t.Error("registry install missing usage")
	}

	if len(install.Flags) != 1 {
		t.Fatalf("registry install has %d flags, want 1", len(install.Flags))
	}

	if install.Flags[0].Name != "--all" {
		t.Errorf("registry install flag = %q, want --all", install.Flags[0].Name)
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

func TestStopCommand(t *testing.T) {
	stop := findSubcommand(&Root, "stop")
	if stop == nil {
		t.Fatal("stop command not found")
	}

	if len(stop.Flags) != 0 {
		t.Fatalf("stop has %d flags, want 0", len(stop.Flags))
	}
}

func TestRmCommand(t *testing.T) {
	rm := findSubcommand(&Root, "rm")
	if rm == nil {
		t.Fatal("rm command not found")
	}

	if len(rm.Flags) != 0 {
		t.Fatalf("rm has %d flags, want 0", len(rm.Flags))
	}

	if rm.Usage != "crew rm <workspace>" {
		t.Errorf("rm Usage = %q, want %q", rm.Usage, "crew rm <workspace>")
	}
}

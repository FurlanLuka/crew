package help

import (
	"os"
	"path/filepath"
	"strings"
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

	expected := []string{"setup", "add", "rm", "show", "start", "stop", "restart", "status", "check", "proxy", "logs", "tui"}
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
	if len(ws.Flags) != 3 {
		t.Fatalf("add workspace should have 3 flags, got %d", len(ws.Flags))
	}
	wantFlags := map[string]bool{"<project>": true, "--direct": true, "--wait": true}
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

	expected := []string{"show", "set", "refresh"}
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
	for _, name := range []string{"env", "run", "migrate", "uninstall", "setup", "duplicate", "add", "rm", "ls", "dev", "export", "import", "claude", "edit", "open", "trash", "debug", "verify", "fix", "config", "code", "start", "launch", "show", "ps", "kill", "update", "check", "clean"} {
		if findSubcommand(&Root, name) == nil {
			t.Errorf("top-level command %q not documented", name)
		}
	}
}

// The skill is what an agent reads to drive crew. Every usage line in the help
// tree must appear in it verbatim, so adding a command without documenting it
// there fails here rather than in someone's session.
func TestSkillDocumentsEveryUsage(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "skills", "crew", "SKILL.md"))
	if err != nil {
		t.Fatalf("skill: %v", err)
	}
	skill := string(data)

	var walk func(c *CommandInfo)
	walk = func(c *CommandInfo) {
		// A usage with alternatives lists each form; every form is required.
		for _, form := range strings.Split(c.Usage, " | crew ") {
			form = strings.TrimSpace(form)
			if form == "" {
				continue
			}
			if !strings.HasPrefix(form, "crew ") {
				form = "crew " + form
			}
			if !strings.Contains(skill, form) {
				t.Errorf("skills/crew/SKILL.md does not contain %q", form)
			}
		}
		// Output columns are quoted in the skill too; they drift just as easily.
		if c.OutputFormat != "" && !strings.Contains(skill, c.OutputFormat) {
			t.Errorf("skills/crew/SKILL.md does not contain the output format %q of %q", c.OutputFormat, c.Usage)
		}
		for i := range c.Subcommands {
			walk(&c.Subcommands[i])
		}
	}
	for i := range Root.Subcommands {
		walk(&Root.Subcommands[i])
	}
}

// The proxy is the one part of crew whose failures happen on a device crew
// cannot see; the notes are where a user standing there is sent.
func TestProxyNotes(t *testing.T) {
	for _, path := range [][]string{{"dev", "start"}, {"config", "set"}} {
		cmd := &Root
		for _, name := range path {
			cmd = findSubcommand(cmd, name)
		}
		if len(cmd.Notes) == 0 {
			t.Errorf("%v should carry notes", path)
		}
	}
}

func TestPrintHelp_Snapshot(t *testing.T) {
	cmd := &CommandInfo{
		Name:         "set",
		Description:  "Set a value",
		Usage:        "crew config set <key> <value>",
		Flags:        []FlagInfo{{Name: "--force", Description: "Do it", Default: "off"}},
		OutputFormat: "<key>\\t<value>",
		Examples:     []string{"crew config set a b"},
		Notes:        []string{"first note", "  indented detail"},
	}
	var b strings.Builder
	printHelp(&b, cmd, []string{"config", "set"})
	want := strings.Join([]string{
		"crew config set - Set a value",
		"",
		"Usage: crew config set <key> <value>",
		"",
		"Flags:",
		"  --force  Do it (default: off)",
		"",
		"Output: <key>\\t<value>",
		"",
		"Examples:",
		"  crew config set a b",
		"",
		"Notes:",
		"  first note",
		"    indented detail",
		"",
	}, "\n")
	if b.String() != want {
		t.Errorf("printHelp =\n%s\nwant\n%s", b.String(), want)
	}
}

// Notes exist because a description also renders in the parent's command
// list; a note must never leak there.
func TestPrintHelp_NotesStayOffParentList(t *testing.T) {
	parent := &CommandInfo{Name: "dev", Description: "Dev servers", Subcommands: []CommandInfo{
		{Name: "start", Description: "Start them", Notes: []string{"the long story"}},
	}}
	var b strings.Builder
	printHelp(&b, parent, []string{"dev"})
	if strings.Contains(b.String(), "Notes:") || strings.Contains(b.String(), "the long story") {
		t.Errorf("parent list carries a note:\n%s", b.String())
	}
}

// Roles and rm project --purge left in 4.0; no usage, flag or note may
// still offer them.
func TestNoRolesOrPurgeOnRmProject(t *testing.T) {
	var walk func(c *CommandInfo, path string)
	walk = func(c *CommandInfo, path string) {
		texts := []string{c.Usage, c.Description}
		texts = append(texts, c.Notes...)
		texts = append(texts, c.Examples...)
		for _, f := range c.Flags {
			texts = append(texts, f.Name, f.Description)
		}
		for _, text := range texts {
			if strings.Contains(text, "--role") || strings.Contains(text, ":<role>") {
				t.Errorf("%s still offers roles: %q", path, text)
			}
			if path == "rm project" && strings.Contains(text, "--purge") {
				t.Errorf("rm project still offers --purge: %q", text)
			}
		}
		for i := range c.Subcommands {
			walk(&c.Subcommands[i], strings.TrimSpace(path+" "+c.Subcommands[i].Name))
		}
	}
	walk(&Root, "")
	if rm := findSubcommand(findSubcommand(&Root, "rm"), "project"); rm.Usage != "crew rm project <name> [--keep-clone]" {
		t.Errorf("rm project usage = %q", rm.Usage)
	}
}

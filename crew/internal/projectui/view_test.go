package projectui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// enter and the section letters open the project page, the cursor on the
// section asked for; a pushes the wizard.
func TestProjectView_OpensThePage(t *testing.T) {
	setupTestConfig(t)
	project.Add(project.Project{Name: "api", Path: "/p", Setup: "make sync", DevServers: []project.DevServer{{Name: "api", Port: 3000, Command: "x"}}})
	v := NewView()
	m, _ := v.Update(projectsLoadedMsg{projects: []project.Project{*project.Get("api")}})
	v = m.(View)
	if got := v.View(); !strings.Contains(got, "setup: make sync") || !strings.Contains(got, listHelp) {
		t.Errorf("list:\n%s", got)
	}
	for k, want := range map[string]rowKind{"enter": rowSetup, "t": rowSetup, "e": rowEnv, "s": rowServer, "b": rowBinding} {
		page, ok := pushed(v, k).(Page)
		if !ok || page.name != "api" || page.pending == nil || page.pending.kind != want {
			t.Errorf("%s pushed %+v", k, pushed(v, k))
		}
	}
	if _, ok := pushed(v, "a").(Wizard); !ok {
		t.Error("a pushes the wizard")
	}
	empty := NewView()
	if pushed(empty, "enter") != nil || pushed(empty, "s") != nil {
		t.Error("an empty pool has no page to open")
	}
	if _, cmd := empty.Update(tea.KeyMsg{Type: tea.KeyEsc}); cmd == nil {
		t.Error("esc pops")
	} else if _, ok := cmd().(app.PopPageMsg); !ok {
		t.Error("esc pops the list")
	}
}

// The enum owns what differs between the two commands.
func TestCommandField(t *testing.T) {
	p := project.Project{Setup: "make sync", EnvCmd: "make get-env"}
	for _, tt := range []struct {
		f                            commandField
		label, value, placeholderHas string
	}{
		{cmdSetup, "Setup command", "make sync", "lockfile"},
		{cmdEnvCmd, "Env command", "make get-env", ".env"},
	} {
		if tt.f.label() != tt.label || tt.f.value(p) != tt.value || !strings.Contains(tt.f.placeholder(), tt.placeholderHas) {
			t.Errorf("%v: %q %q %q", tt.f, tt.f.label(), tt.f.value(p), tt.f.placeholder())
		}
	}
}

func TestPoolRemovePrompt(t *testing.T) {
	setupTestConfig(t)
	owned := project.Project{Name: "store-api", Path: filepath.Join(config.ProjectsDir, "store-api")}
	if got := poolRemovePrompt(owned); got != "Remove store-api? Its clone at "+owned.Path+" goes to the trash. (y/n)" {
		t.Errorf("owned: %q", got)
	}
	adopted := project.Project{Name: "checkout-api", Path: "/code/checkout-api"}
	if got := poolRemovePrompt(adopted); got != "Remove checkout-api? Your checkout at /code/checkout-api is left alone. (y/n)" {
		t.Errorf("adopted: %q", got)
	}
}

// d asks with the prompt; y removes through the pool op — the clone goes
// to the trash, a member is refused with the hint, n keeps everything.
func TestProjectView_RemovesThroughThePool(t *testing.T) {
	setupTestConfig(t)
	owned := filepath.Join(config.ProjectsDir, "signals")
	os.MkdirAll(owned, 0o755)
	project.Add(project.Project{Name: "signals", Path: owned})
	project.Add(project.Project{Name: "store-api", Path: "/code/store-api"})
	workspace.Save(&workspace.Workspace{Name: "ws", Projects: []workspace.WorkspaceProject{{Name: "store-api"}}, Worktrees: []workspace.Worktree{{Name: "main"}}})
	list, _ := project.List()
	v := NewView()
	m, _ := v.Update(projectsLoadedMsg{projects: list})
	v = m.(View)

	press := func(k string) {
		v = settle(t, v, keyOf(k)).(View)
	}
	press("d")
	if got := plain(v.View()); !strings.Contains(got, "Remove signals? Its clone at "+owned+" goes to the trash. (y/n)") {
		t.Fatalf("prompt:\n%s", got)
	}
	press("n")
	if project.Get("signals") == nil {
		t.Fatal("n keeps it")
	}
	press("d")
	press("y")
	if project.Get("signals") != nil || v.statusMsg != "Removed 'signals' — clone at "+owned+" moved to the trash" {
		t.Errorf("after y: get=%v status=%q err=%v", project.Get("signals"), v.statusMsg, v.err)
	}
	if _, err := os.Stat(owned); !os.IsNotExist(err) {
		t.Error("the clone should be in the trash")
	}
	// The member is refused.
	press("d")
	press("y")
	if project.Get("store-api") == nil || v.err == nil || !strings.Contains(v.err.Error(), "crew rm workspace ws store-api") {
		t.Errorf("member: get=%v err=%v", project.Get("store-api"), v.err)
	}
}

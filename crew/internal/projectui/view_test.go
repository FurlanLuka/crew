package projectui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/project"
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

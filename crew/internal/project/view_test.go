package project

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// t and e open the same one-line form on the project's two commands; enter
// saves the one that was opened.
func TestProjectView_CommandForms(t *testing.T) {
	setupTestConfig(t)
	Add(Project{Name: "api", Path: "/p", Setup: "make sync"})
	v := NewView()
	m, _ := v.Update(projectsLoadedMsg{projects: []Project{{Name: "api", Path: "/p", Setup: "make sync"}}})
	v = m.(View)
	press := func(v View, k string) (View, tea.Cmd) {
		m, cmd := v.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(k)})
		return m.(View), cmd
	}

	v, _ = press(v, "e")
	if v.state != stateCommandForm || v.editing != fieldEnvCmd || v.commandInput.Value() != "" {
		t.Fatalf("e: state=%v field=%v value=%q", v.state, v.editing, v.commandInput.Value())
	}
	if got := v.View(); !strings.Contains(got, "Env command for api") || !strings.Contains(got, "not print values") {
		t.Errorf("env form:\n%s", got)
	}
	v.commandInput.SetValue("make get-env")
	m, cmd := v.Update(tea.KeyMsg{Type: tea.KeyEnter})
	v = m.(View)
	saved := cmd()
	if msg, ok := saved.(commandSavedMsg); !ok || msg.field != fieldEnvCmd {
		t.Fatalf("enter → %T %+v", saved, saved)
	}
	if got := Get("api"); got.EnvCmd != "make get-env" || got.Setup != "make sync" {
		t.Errorf("saved = %+v", got)
	}
	m, _ = v.Update(commandSavedMsg{name: "api", field: fieldEnvCmd})
	v = m.(View)
	if v.statusMsg != "Env command for 'api' saved" || v.state != stateList {
		t.Errorf("after save: status=%q state=%v", v.statusMsg, v.state)
	}

	v, _ = press(v, "t")
	if v.editing != fieldSetup || v.commandInput.Value() != "make sync" || !strings.HasPrefix(v.commandInput.Placeholder, "make sync") {
		t.Errorf("t: field=%v value=%q placeholder=%q", v.editing, v.commandInput.Value(), v.commandInput.Placeholder)
	}

	m, _ = v.Update(projectsLoadedMsg{projects: []Project{{Name: "api", Path: "/p", Setup: "make sync", EnvCmd: "make get-env"}}})
	v = m.(View)
	v.state = stateList
	if got := v.View(); !strings.Contains(got, "env: make get-env") || !strings.Contains(got, "e env cmd") {
		t.Errorf("list:\n%s", got)
	}
}

// The enum owns what differs between the two commands.
func TestCommandField(t *testing.T) {
	p := Project{Setup: "make sync", EnvCmd: "make get-env"}
	for _, tt := range []struct {
		f                            commandField
		label, value, placeholderHas string
	}{
		{fieldSetup, "Setup command", "make sync", "lockfile"},
		{fieldEnvCmd, "Env command", "make get-env", ".env"},
	} {
		if tt.f.label() != tt.label || tt.f.value(p) != tt.value || !strings.Contains(tt.f.placeholder(), tt.placeholderHas) {
			t.Errorf("%v: %q %q %q", tt.f, tt.f.label(), tt.f.value(p), tt.f.placeholder())
		}
	}
}

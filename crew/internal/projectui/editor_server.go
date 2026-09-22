package projectui

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

// serverForm is the four fields of a dev server, edited in place by the
// page and the wizard. A plain sub-model: no Init, fed at open time, and
// its save comes back to the host as savedMsg so the host reloads.
type serverForm struct {
	proj   string
	inputs [4]textinput.Model
	field  int
	// orig is the server's name when the form opened; "" when adding. A
	// rename goes through RenameDevServer so the bindings scoped to it
	// follow; an add never renames, even onto a name that exists —
	// AddDevServer replaces by name.
	orig string
	err  error
}

const (
	serverName = iota
	serverPort
	serverCommand
	serverDir
)

func newServerForm(proj string, edit *project.DevServer) serverForm {
	var inputs [4]textinput.Model
	placeholders := [4]string{"web", "5173 (empty: does not listen)", "npm run dev", "apps/web (optional)"}
	limits := [4]int{32, 6, 128, 128}
	for i := range inputs {
		inputs[i] = textinput.New()
		inputs[i].Placeholder = placeholders[i]
		inputs[i].CharLimit = limits[i]
	}
	f := serverForm{proj: proj, inputs: inputs}
	if edit != nil {
		f.orig = edit.Name
		f.inputs[serverName].SetValue(edit.Name)
		if edit.Listens() {
			f.inputs[serverPort].SetValue(strconv.Itoa(edit.Port))
		}
		f.inputs[serverCommand].SetValue(edit.Command)
		f.inputs[serverDir].SetValue(edit.Dir)
		for i := range f.inputs {
			f.inputs[i].CursorEnd()
		}
	}
	return f
}

// focusField is what the host batches when it opens the form.
func (f *serverForm) focusField(field int) tea.Cmd {
	f.field = field
	for i := range f.inputs {
		if i == field {
			f.inputs[i].Focus()
		} else {
			f.inputs[i].Blur()
		}
	}
	return f.inputs[field].Cursor.BlinkCmd()
}

// Update takes every key the host forwards: tab cycles, enter validates
// here (a typo'd port is an error on the form, not a frame later) and
// saves through a command. esc is the host's.
func (f serverForm) Update(msg tea.Msg) (serverForm, tea.Cmd) {
	if k, ok := msg.(tea.KeyMsg); ok {
		switch k.String() {
		case "tab":
			cmd := f.focusField((f.field + 1) % 4)
			return f, cmd
		case "shift+tab":
			cmd := f.focusField((f.field + 3) % 4)
			return f, cmd
		case "enter":
			ds, err := parseServerForm(f.inputs[serverName].Value(), f.inputs[serverPort].Value(), f.inputs[serverCommand].Value(), f.inputs[serverDir].Value())
			if err != nil {
				f.err = err
				return f, nil
			}
			f.err = nil
			proj, orig := f.proj, f.orig
			return f, func() tea.Msg {
				if orig != "" && orig != ds.Name {
					if err := project.RenameDevServer(proj, orig, ds); err != nil {
						return errMsg{err}
					}
					return savedMsg{sectionServers, ds.Name}
				}
				if err := project.AddDevServer(proj, ds); err != nil {
					return errMsg{err}
				}
				return savedMsg{sectionServers, ds.Name}
			}
		}
	}
	var cmd tea.Cmd
	f.inputs[f.field], cmd = f.inputs[f.field].Update(msg)
	return f, cmd
}

// parseServerForm turns the four fields into a server, or the reason they
// are not one. Pure.
func parseServerForm(name, port, command, dir string) (project.DevServer, error) {
	name, port, command, dir = strings.TrimSpace(name), strings.TrimSpace(port), strings.TrimSpace(command), strings.TrimSpace(dir)
	if name == "" || command == "" {
		return project.DevServer{}, errors.New("name and command are required")
	}
	n := 0
	if port != "" {
		var err error
		if n, err = strconv.Atoi(port); err != nil || n <= 0 {
			return project.DevServer{}, errors.New("invalid port number")
		}
	}
	return project.DevServer{Name: name, Port: n, Command: command, Dir: dir}, nil
}

func (f serverForm) View() string {
	var b strings.Builder
	action := "Adding server"
	if f.orig != "" {
		action = "Editing server"
	}
	fmt.Fprintf(&b, "  %s\n", action)
	labels := [4]string{"name     ", "port     ", "command  ", "dir      "}
	for i, label := range labels {
		b.WriteString("  " + label + f.inputs[i].View() + "\n")
	}
	b.WriteString("  " + app.Subtle.Render("the command must listen on $PORT — crew allocates the real port per worktree; this one is the reference. No port: a process that does not listen (a worker) — no $PORT, no URL") + "\n")
	if f.err != nil {
		b.WriteString("  " + app.Error.Render(f.err.Error()) + "\n")
	}
	b.WriteString("  " + app.HelpStyle.Render("tab next field  enter save  esc cancel") + "\n")
	return b.String()
}

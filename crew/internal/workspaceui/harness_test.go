package workspaceui

import (
	"fmt"
	"os"
	osexec "os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	crewexec "github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/trash"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// The harness is the one projectui uses — a third copy; a shared
// internal/app/apptest is a noted follow-up.

func setupTestConfig(t *testing.T) string {
	t.Helper()
	tmp := t.TempDir()
	config.ConfigDir = tmp
	config.WorkspacesDir = filepath.Join(tmp, "workspaces")
	config.TrashDir = filepath.Join(tmp, "trash")
	config.ProjectsDir = filepath.Join(tmp, "projects")
	config.ClaudeConfigDir = filepath.Join(tmp, "claude")
	os.MkdirAll(config.WorkspacesDir, 0o755)
	// Trashed checkouts stay put so tests can look at them.
	trash.DisableSweepForTest(t)
	// Removals StopProxyIfIdle on the shared tmux server; a name of our
	// own keeps that away from a live proxy.
	prevProxy := dev.ProxySessionName
	dev.ProxySessionName = fmt.Sprintf("crew-test-proxy-%d", os.Getpid())
	t.Cleanup(func() {
		crewexec.KillTmuxSession(dev.ProxySessionName)
		dev.ProxySessionName = prevProxy
	})
	// Runners in-process, one after another: a creation is done when the
	// command returns, so the first reload reads what they recorded.
	prev := workspace.SpawnRunner
	workspace.SpawnRunner = func(ref workspace.Ref, job workspace.ProjectJob) error { return workspace.RunProjectSetup(ref, job) }
	t.Cleanup(func() { workspace.SpawnRunner = prev })
	prevExit := workspace.RunnerExitWait
	workspace.RunnerExitWait = 50 * time.Millisecond
	t.Cleanup(func() { workspace.RunnerExitWait = prevExit })
	return tmp
}

// backgroundRunners runs each job in a goroutine — the real shape, minus
// tmux — for the tests about a runner still alive.
func backgroundRunners(t *testing.T) {
	t.Helper()
	prev := workspace.SpawnRunner
	var wg sync.WaitGroup
	workspace.SpawnRunner = func(ref workspace.Ref, job workspace.ProjectJob) error {
		wg.Add(1)
		go func() {
			defer wg.Done()
			workspace.RunProjectSetup(ref, job)
		}()
		return nil
	}
	t.Cleanup(func() {
		wg.Wait()
		workspace.SpawnRunner = prev
	})
}

// initRepo makes dir a git repo with one empty commit on main — a member
// with no lockfile and no servers, so a creation runs no install and
// starts nothing.
func initRepo(t *testing.T, dir string) {
	t.Helper()
	os.MkdirAll(dir, 0o755)
	for _, args := range [][]string{
		{"init", "--initial-branch=main"},
		{"-c", "user.email=a@b", "-c", "user.name=test", "commit", "--allow-empty", "-m", "init"},
	} {
		cmd := osexec.Command("git", append([]string{"-C", dir}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
}

// checkoutInTrash puts one entry in the trash, as a removal would.
func checkoutInTrash(t *testing.T, base string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(config.TrashDir, "1-"+base), 0o755); err != nil {
		t.Fatal(err)
	}
}

var ansi = regexp.MustCompile(`\x1b\[[0-9;]*m`)

func plain(s string) string { return ansi.ReplaceAllString(s, "") }

func keyRune(r string) tea.KeyMsg { return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(r)} }

func keyOf(k string) tea.Msg {
	switch k {
	case "esc":
		return tea.KeyMsg{Type: tea.KeyEsc}
	case "enter":
		return tea.KeyMsg{Type: tea.KeyEnter}
	case " ":
		return tea.KeyMsg{Type: tea.KeySpace}
	case "down":
		return tea.KeyMsg{Type: tea.KeyDown}
	case "up":
		return tea.KeyMsg{Type: tea.KeyUp}
	case "ctrl+p":
		return tea.KeyMsg{Type: tea.KeyCtrlP}
	case "ctrl+c":
		return tea.KeyMsg{Type: tea.KeyCtrlC}
	}
	return keyRune(k)
}

// settle sends a message and feeds the model's own messages back until
// it settles — every step applies through a command, and tests want the
// settled state. Pushes and pops are collected, not dropped.
func settle(t *testing.T, m tea.Model, msg tea.Msg) (tea.Model, []tea.Msg) {
	t.Helper()
	m, cmd := m.Update(msg)
	var nav []tea.Msg
	for _, out := range runCmd(cmd, &nav) {
		var more []tea.Msg
		m, more = settle(t, m, out)
		nav = append(nav, more...)
	}
	return m, nav
}

// runCmd runs a command tree and keeps the model's own messages. It drops
// what would reschedule or leave — spinner ticks, cursor blinks, quits —
// and puts page pushes and pops aside for the test to look at.
func runCmd(cmd tea.Cmd, nav *[]tea.Msg) []tea.Msg {
	if cmd == nil {
		return nil
	}
	var out []tea.Msg
	switch msg := cmd().(type) {
	case nil:
	case tea.BatchMsg:
		results := make([][]tea.Msg, len(msg))
		navs := make([][]tea.Msg, len(msg))
		var wg sync.WaitGroup
		for i, sub := range msg {
			wg.Add(1)
			go func() {
				defer wg.Done()
				results[i] = runCmd(sub, &navs[i])
			}()
		}
		wg.Wait()
		for i, r := range results {
			out = append(out, r...)
			*nav = append(*nav, navs[i]...)
		}
	case app.PushPageMsg, app.PopPageMsg:
		*nav = append(*nav, msg)
	case spinner.TickMsg, tea.QuitMsg:
	default:
		// The cursor's blink messages reschedule themselves; the initial
		// one is unexported, so the package is what to drop on.
		if strings.HasSuffix(reflect.TypeOf(msg).PkgPath(), "bubbles/cursor") {
			return nil
		}
		out = append(out, msg)
	}
	return out
}

// pushedPage is the page a settled step pushed, nil when none.
func pushedPage(nav []tea.Msg) app.Page {
	for _, m := range nav {
		if p, ok := m.(app.PushPageMsg); ok {
			return p.Page
		}
	}
	return nil
}

// popped is the pop a settled step sent, if any.
func popped(nav []tea.Msg) (app.PopPageMsg, bool) {
	for _, m := range nav {
		if p, ok := m.(app.PopPageMsg); ok {
			return p, true
		}
	}
	return app.PopPageMsg{}, false
}

// quits: the key ends the program.
func quits(m tea.Model, k string) bool {
	_, cmd := m.Update(keyOf(k))
	if cmd == nil {
		return false
	}
	_, ok := cmd().(tea.QuitMsg)
	return ok
}

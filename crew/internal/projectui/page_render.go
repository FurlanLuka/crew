package projectui

import (
	"fmt"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// pageChrome is what app.View draws above a page: a blank, the title, a
// blank. The window the page fits itself into is the terminal minus that.
const pageChrome = 3

// formBlock is an open form rendered to a string, and where it goes.
type formBlock struct {
	section section
	body    string
}

// checkView is the check as the page shows and acts on it: the card while
// it is the one that ran, the record otherwise. One triage for the row,
// the health block on top and the collapsed line. Pure.
type checkView struct {
	phase   checkPhase
	health  *workspace.Health
	at      time.Time
	kept    bool
	smoked  bool
	running bool // a runner alive, on this card or on disk
}

func resolveCheck(info workspace.CheckInfo, card checkCard) checkView {
	switch card.phase {
	case checkRunning:
		return checkView{phase: checkRunning, running: true}
	case checkFailed, checkConfirm:
		return checkView{phase: card.phase, health: card.health, at: info.At, kept: card.kept}
	case checkPassed:
		return checkView{phase: checkPassed, at: info.At, smoked: card.smoke}
	}
	switch info.State {
	case workspace.CheckRunning:
		return checkView{phase: checkRunning, running: true}
	case workspace.CheckPassed:
		return checkView{phase: checkPassed, at: info.At, smoked: info.Smoked}
	case workspace.CheckFailed:
		return checkView{phase: checkFailed, health: info.Health, at: info.At, kept: true}
	}
	return checkView{}
}

// checkLine is the Check row. A pass that started no servers says so —
// unless there were none to start, when the install is the whole check.
// Pure.
func checkLine(v checkView, hasServers bool, now time.Time) string {
	switch v.phase {
	case checkRunning:
		return "● running — l logs"
	case checkPassed:
		line := "✓ reproduces from nothing"
		if !v.smoked && hasServers {
			line = "✓ install — servers not smoked"
		}
		when := ""
		if !v.at.IsZero() {
			when = " · " + workspace.AgoAt(v.at, now)
		}
		return app.Success.Render(line) + app.Subtle.Render(when+" — c checks again")
	case checkFailed, checkConfirm:
		keys := "c check again  l logs"
		if v.kept {
			keys = "f fix with Claude  " + keys
		}
		what := "✗ the runner vanished"
		if v.health != nil {
			what = "✗ " + v.health.Summary()
		}
		when := ""
		if !v.at.IsZero() {
			when = " · " + workspace.AgoAt(v.at, now)
		}
		return app.Error.Render(what) + app.Subtle.Render(when+" — "+keys)
	}
	return app.Subtle.Render("no check on record — c checks it")
}

// renderProjectPage draws the page body and says which line the cursor is
// on, so the view can window around it. Pure over its inputs. A form open
// in one section collapses the others to a summary line each, so the
// form and its preview fit a 24-line terminal.
func renderProjectPage(f pageFacts, rows []pageRow, cursor int, open formBlock, card checkCard) (string, int) {
	v := resolveCheck(f.check, card)
	var b strings.Builder
	cursorLine := 0
	line := func() int { return strings.Count(b.String(), "\n") }
	formOpen := open.body != ""
	collapsed := func(s section) bool { return formOpen && open.section != s }
	sel := func(kind rowKind, idx int) bool {
		if cursor < 0 || cursor >= len(rows) || rows[cursor].Kind != kind {
			return false
		}
		switch kind {
		case rowServer, rowBinding, rowProposal:
			return rows[cursor].Index == idx
		}
		return true
	}
	row := func(kind rowKind, idx int, label, rest string) {
		s := sel(kind, idx)
		if s {
			cursorLine = line()
		}
		b.WriteString("  " + app.RowPrefix(s) + app.RowName(fmt.Sprintf("%-16s", label), s) + rest + "\n")
	}

	// Identity: the remote names the project, the path is where crew's
	// clone (or the adopted checkout) is.
	owned := "crew's clone"
	if !project.CrewOwned(f.proj) {
		owned = "adopted"
	}
	b.WriteString("  " + app.Subtle.Render(orNone(f.remote)+" · "+config.Tildify(f.proj.Path)+" ("+owned+")") + "\n")

	// A kept failure comes first: it is the reason the check row is red.
	if v.health != nil && !formOpen {
		workspace.RenderHealthAt(&b, v.health, f.now)
	}
	b.WriteString("\n")

	// Install
	if collapsed(sectionInstall) {
		b.WriteString("  " + app.Subtle.Render("Install · "+orNone(exec.StepLine(exec.ComposeSteps(f.detected, f.proj.Setup, f.proj.EnvCmd)))) + "\n")
	} else {
		b.WriteString("  Install\n")
		row(rowSetup, 0, "setup", orNone(f.proj.Setup))
		if open.section == sectionInstall {
			b.WriteString(open.body)
		}
		row(rowEnv, 0, "env", orNone(f.proj.EnvCmd))
		b.WriteString("                     " + app.Subtle.Render("a new checkout runs  "+orNone(exec.StepLine(exec.ComposeSteps(f.detected, f.proj.Setup, f.proj.EnvCmd)))) + "\n")
	}

	// Servers
	if collapsed(sectionServers) {
		b.WriteString("  " + app.Subtle.Render(fmt.Sprintf("Servers %d", len(f.proj.DevServers))) + "\n")
	} else {
		b.WriteString("  Servers\n")
		if len(f.proj.DevServers) == 0 {
			row(rowNoServers, 0, "", app.Subtle.Render("none — a adds one; the command must listen on $PORT"))
		}
		for i, ds := range f.proj.DevServers {
			rest := fmt.Sprintf(":%-6d %s", ds.Port, ds.Command)
			if ds.Dir != "" {
				rest += "  " + app.Subtle.Render("dir:"+ds.Dir)
			}
			row(rowServer, i, ds.Name, rest)
		}
		if open.section == sectionServers {
			b.WriteString(open.body)
		}
	}

	// Bindings, then what the env files propose and nothing binds yet.
	if collapsed(sectionBindings) {
		found := ""
		if n := len(f.proposals); n > 0 {
			found = fmt.Sprintf(" · %d found", n)
		}
		b.WriteString("  " + app.Subtle.Render(fmt.Sprintf("Bindings %d%s", len(f.proj.Bindings), found)) + "\n")
	} else {
		b.WriteString("  Bindings\n")
		if len(f.proj.Bindings) == 0 && len(f.proposals) == 0 {
			row(rowNoBindings, 0, "", app.Subtle.Render("none — a adds one; a binding points a var at a sibling's port"))
		}
		width := 0
		for _, bd := range f.proj.Bindings {
			width = max(width, len(bd.Value))
		}
		for i, bd := range f.proj.Bindings {
			rest := fmt.Sprintf("%-*s  ", width, bd.Value)
			if dev.IsLegacyToken(bd.Value) {
				rest += app.Subtle.Render("· old form  ")
			}
			rest += renderPreviewInline(f.previews[bd.Key()])
			row(rowBinding, i, bd.Label(), rest)
		}
		for i, pr := range f.proposals {
			if i == maxProposalRows {
				b.WriteString("      " + app.Subtle.Render(fmt.Sprintf("○ +%d more found — A adds all", len(f.proposals)-maxProposalRows)) + "\n")
				break
			}
			rest := app.Subtle.Render(fmt.Sprintf("%-*s  ", width, pr.Template))
			if pr.Ambiguous {
				rest = app.Highlight.Render(fmt.Sprintf("? two projects on :%d — enter picks by hand", pr.Port))
			} else {
				rest += app.Subtle.Render("found in .env — enter adds it")
			}
			row(rowProposal, i, "○ "+pr.Var, rest)
		}
		if open.section == sectionBindings {
			b.WriteString(open.body)
		}
	}

	// Check
	if collapsed(sectionCheck) {
		b.WriteString("  " + app.Subtle.Render("Check · "+plainCheck(v)) + "\n")
	} else {
		b.WriteString("  Check\n")
		switch {
		case card.phase == checkRunning:
			if table := card.table(); table != "" {
				b.WriteString(table)
			} else {
				b.WriteString("  " + card.runningLine() + "\n")
			}
		case card.starting:
			b.WriteString("  " + card.startingLine() + "\n")
		default:
			row(rowCheck, 0, "", checkLine(v, len(f.proj.DevServers) > 0, f.now))
		}
		if card.phase == checkConfirm {
			b.WriteString("  " + app.Highlight.Render(card.confirmLine()) + "\n")
		}
	}
	return b.String(), cursorLine
}

// plainCheck is the check's one word for a collapsed section. Pure.
func plainCheck(v checkView) string {
	switch v.phase {
	case checkRunning:
		return "running"
	case checkFailed, checkConfirm:
		return "✗"
	case checkPassed:
		return "✓"
	}
	return "none"
}

// window keeps the cursor's line on screen: the body's lines cut to
// height around it, the top kept while the cursor is near it. height ≤ 0
// is no limit. Pure.
func window(lines []string, cursorLine, height int) []string {
	if height <= 0 || len(lines) <= height {
		return lines
	}
	start := 0
	if cursorLine >= height {
		start = cursorLine - height + 1
	}
	if start+height > len(lines) {
		start = len(lines) - height
	}
	return lines[start : start+height]
}

func (p Page) View() string {
	var open formBlock
	switch p.open {
	case openCommand:
		open = formBlock{sectionInstall, p.renderCommandForm()}
	case openServer:
		open = formBlock{sectionServers, p.serverForm.View()}
	case openBinding:
		open = formBlock{sectionBindings, p.editor.View()}
	}
	body, cursorLine := renderProjectPage(p.facts, p.rows, p.cursor, open, p.check)

	var tail strings.Builder
	switch {
	case p.confirm != nil:
		tail.WriteString("  " + app.Highlight.Render(p.confirm.prompt) + "\n")
	case p.status != "":
		tail.WriteString("  " + app.Success.Render(p.status) + "\n")
	case p.err != nil:
		tail.WriteString("  " + app.Error.Render(p.err.Error()) + "\n")
	}
	if p.open == openNone && p.confirm == nil {
		v := resolveCheck(p.facts.check, p.check)
		keys := pageKeys(p.rows, p.cursor, facts{phase: v.phase, canFix: v.kept && v.phase == checkFailed})
		tail.WriteString("  " + app.HelpStyle.Render(strings.Join(keys, "  ")) + "\n")
		if cli := pageCLI(p.rows, p.cursor, p.name); cli != "" {
			tail.WriteString("  " + app.Subtle.Render(cli) + "\n")
		}
	}

	// The tail is pinned; the body gets what height is left.
	tailLines := strings.Count(tail.String(), "\n")
	lines := strings.Split(strings.TrimRight(body, "\n"), "\n")
	if p.height > 0 {
		lines = window(lines, cursorLine, p.height-pageChrome-tailLines-1)
	}
	return strings.Join(lines, "\n") + "\n\n" + tail.String()
}

// renderCommandForm is the one-line form under the setup or env row.
func (p Page) renderCommandForm() string {
	return "                 " + p.cmdInput.View() + "\n" +
		"                 " + app.Subtle.Render(p.cmdField.hint()) + "\n" +
		"                 " + app.HelpStyle.Render("enter save  esc cancel") + "\n"
}

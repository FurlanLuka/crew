package projectui

import (
	"fmt"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/app"
	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// Every card: header, the concept block, the fields or the facts, the
// error line, the keys, the CLI form of the same step. Pure over the
// model's fields, so a card can be asserted as a whole.

func (w Wizard) View() string {
	var b strings.Builder
	switch w.step {
	case stepSource:
		w.renderSource(&b)
	case stepInstall:
		w.renderInstall(&b)
	case stepServers:
		w.renderServers(&b)
	case stepBindings:
		w.renderBindings(&b)
	case stepCheck:
		w.renderCheck(&b)
	default:
		renderFinish(&b, w.finish())
	}
	return b.String()
}

func concept(b *strings.Builder, lines []string) {
	for _, l := range lines {
		b.WriteString("  " + app.Subtle.Render(l) + "\n")
	}
	b.WriteString("\n")
}

func (w Wizard) errLine(b *strings.Builder) {
	if w.err != nil {
		b.WriteString("  " + app.Error.Render("! "+w.err.Error()) + "\n\n")
	}
}

// footer is the keys and the CLI line, from the same facts the handler
// reads.
func (w Wizard) footer(b *strings.Builder) {
	f := w.currentFacts()
	keys := keysFor(w.step, f)
	if esc := escLabel(w.step, f); esc != "" {
		keys = append(keys, esc)
	}
	b.WriteString("  " + app.HelpStyle.Render(strings.Join(keys, "  ")) + "\n")
	if cli := cliFor(w.step, w.name, f); cli != "" {
		b.WriteString("  " + app.Subtle.Render(cli) + "\n")
	}
}

func (w Wizard) renderSource(b *strings.Builder) {
	suffix := ""
	if w.adopting {
		suffix = " · adopt a path"
	}
	b.WriteString(stepHeader(stepSource, suffix))
	if w.adopting {
		concept(b, conceptAdopt)
		b.WriteString("  path      " + w.inputs[fieldPath].View() + "\n")
		b.WriteString("  name      " + w.inputs[fieldName].View() + "\n\n")
	} else {
		concept(b, conceptSource)
		b.WriteString("  url       " + w.inputs[fieldURL].View() + "\n")
		b.WriteString("  name      " + w.inputs[fieldName].View())
		if name := strings.TrimSpace(w.inputs[fieldName].Value()); name != "" {
			b.WriteString("  " + app.Subtle.Render("→ "+config.Tildify(project.ClonePath(name))))
		}
		b.WriteString("\n\n")
	}
	w.errLine(b)
	if w.applying {
		b.WriteString("  " + w.spinner.View() + " " + w.pending + "\n")
		return
	}
	w.footer(b)
}

func (w Wizard) renderInstall(b *strings.Builder) {
	b.WriteString(stepHeader(stepInstall, ""))
	concept(b, conceptInstall)
	b.WriteString("  setup     " + w.inputs[fieldSetup].View() + "\n")
	b.WriteString("  env       " + w.inputs[fieldEnvCmd].View() + "\n\n")
	b.WriteString("  " + app.Subtle.Render("a new checkout would run  ") + app.Highlight.Render(orNone(w.installPreview())) + "\n\n")
	w.errLine(b)
	w.footer(b)
}

func (w Wizard) renderServers(b *strings.Builder) {
	b.WriteString(stepHeader(stepServers, ""))
	concept(b, conceptServers)
	if w.facts.devCmd != "" {
		b.WriteString("  " + app.Subtle.Render("package.json says") + "  " + app.Highlight.Render(w.name+"  "+w.facts.devCmd) + "\n")
		b.WriteString("  port      " + w.inputs[fieldPort].View() + "\n\n")
	} else {
		b.WriteString("  " + app.Subtle.Render("nothing detected — detection reads package.json only; a adds one by hand") + "\n\n")
	}
	renderRows(b, "servers", serverRows(w.facts.proj), "none yet")
	b.WriteString("\n")
	if w.serverForm != nil {
		b.WriteString(w.serverForm.View())
		return
	}
	w.errLine(b)
	w.footer(b)
}

func (w Wizard) renderBindings(b *strings.Builder) {
	b.WriteString(stepHeader(stepBindings, ""))
	concept(b, conceptBindings)
	// The targets, one line each; the token grammar is the editor's to show.
	targets := targetsFor(w.facts.pool, w.name)
	if len(targets) == 0 {
		b.WriteString("  " + app.Highlight.Render(noTargetsLine) + "\n")
	} else {
		renderRows(b, "targets", targetRows(targets), "")
	}
	b.WriteString("  " + app.Subtle.Render(fmt.Sprintf(pointAtLine, w.name)) + "\n\n")
	renderRows(b, "bindings", bindingRows(w.facts.proj), "none yet")
	b.WriteString("\n")
	if w.editor != nil {
		b.WriteString(w.editor.View())
		return
	}
	w.errLine(b)
	w.footer(b)
}

func (w Wizard) renderCheck(b *strings.Builder) {
	b.WriteString(stepHeader(stepCheck, ""))
	concept(b, conceptCheck)
	switch w.check.phase {
	case checkRunning:
		if table := w.check.table(); table != "" {
			b.WriteString(table)
		} else {
			b.WriteString("  " + w.check.runningLine() + "\n")
		}
		b.WriteString("\n")
	case checkFailed, checkConfirm:
		b.WriteString(w.check.table())
		workspace.RenderHealth(b, w.check.health)
		b.WriteString("\n")
		if w.check.phase == checkConfirm {
			b.WriteString("  " + app.Highlight.Render(w.check.confirmLine()) + "\n\n")
		}
	default:
		b.WriteString("  install   " + app.Subtle.Render(orNone(exec.StepLine(exec.ComposeSteps(w.facts.detected, w.facts.proj.Setup, w.facts.proj.EnvCmd)))) + "\n")
		renderRows(b, "servers", serverRows(w.facts.proj), "none")
		b.WriteString("\n")
		switch {
		case w.envMissing():
			b.WriteString("  " + app.Highlight.Render("! "+envMissingLine) + "\n\n")
		case len(w.facts.proj.DevServers) == 0:
			b.WriteString("  " + app.Subtle.Render(noSmokeLine) + "\n\n")
		}
	}
	w.errLine(b)
	if w.applying {
		b.WriteString("  " + w.check.startingLine() + "\n")
		return
	}
	w.footer(b)
}

// renderFinish is the closing card: the project as recorded, the check's
// verdict, and the exact next line. Stopped early, it also names where
// crew project picks each missing piece up.
func renderFinish(b *strings.Builder, c finishCard) {
	p := c.Project
	if c.StoppedAt == stepFinish {
		b.WriteString("  Added " + p.Name + "\n\n")
	} else {
		b.WriteString(fmt.Sprintf("  Add project · stopped at %s\n\n", c.StoppedAt.label()))
	}
	b.WriteString("  remote    " + orNone(c.Remote) + "\n")
	b.WriteString("  path      " + config.Tildify(p.Path) + "\n")
	b.WriteString("  setup     " + orNone(p.Setup) + "\n")
	b.WriteString("  env       " + orNone(p.EnvCmd) + "\n")
	renderRows(b, "servers", serverRows(p), "none")
	renderRows(b, "bindings", bindingRows(p), "none")
	line := c.Verdict.line(p.Name)
	switch c.Verdict {
	case verdictPassed, verdictInstallOnly:
		line = app.Success.Render(line)
	case verdictFailed:
		line = app.Error.Render(line)
	}
	b.WriteString("  check     " + line + "\n\n")
	if keys := c.resumeKeys(); keys != "" {
		b.WriteString("  " + app.Subtle.Render("continue in crew project:  "+keys) + "\n")
		if c.Verdict == verdictNone {
			b.WriteString("  " + app.Subtle.Render("then crew check project "+p.Name) + "\n")
		}
		b.WriteString("\n")
	}
	b.WriteString("  crew add workspace " + wsPlaceholder + " " + p.Name + app.Subtle.Render("   the project joins a workspace; its first worktree is made then") + "\n")
	// Stopped early, the resume line above already names the keys; a walk
	// that reached the check (or the end) gets the generic one.
	if c.resumeKeys() == "" {
		b.WriteString("  crew project" + app.Subtle.Render("   "+resumeAll+" — change any of it later") + "\n")
	}
	b.WriteString("\n")
	b.WriteString("  " + app.HelpStyle.Render("enter close  esc close") + "\n")
}

// renderRows is a labelled list: the label on the first row only.
func renderRows(b *strings.Builder, label string, rows []string, empty string) {
	if len(rows) == 0 {
		b.WriteString(fmt.Sprintf("  %-9s %s\n", label, app.Subtle.Render(empty)))
		return
	}
	for i, r := range rows {
		l := ""
		if i == 0 {
			l = label
		}
		b.WriteString(fmt.Sprintf("  %-9s %s\n", l, r))
	}
}

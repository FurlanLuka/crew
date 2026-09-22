package addproject

import (
	"fmt"
	"path"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// step is the card in hand; the walk is linear, the finish card is not
// numbered.
type step int

const (
	stepSource step = iota
	stepInstall
	stepServers
	stepBindings
	stepCheck
	stepFinish
)

func (s step) label() string {
	return [...]string{"source", "install", "servers", "bindings", "check", "finish"}[s]
}

// checkPhase is where the check step stands.
type checkPhase int

const (
	checkIdle checkPhase = iota
	checkRunning
	checkPassed
	checkFailed
	checkConfirm // c on a checkout with unmerged fix commits asks first
)

// facts is what decides a card's keys — read by the handler and the
// footer alike, so a key the help offers is always one the handler takes.
type facts struct {
	adopting  bool // source: the path field is open
	detected  bool // servers: a command was read off package.json
	targets   bool // bindings: another project has servers
	phase     checkPhase
	canFix    bool // check failed and its record is still there for f
	fromCheck bool // install/servers opened from the failed check card
}

// keysFor is a card's key line, without the esc every card has. Pure.
func keysFor(s step, f facts) []string {
	switch s {
	case stepSource:
		if f.adopting {
			return []string{"enter adopt", "tab name"}
		}
		return []string{"enter clone", "tab name", "ctrl+p adopt a path"}
	case stepInstall:
		return []string{"tab next", "enter save"}
	case stepServers:
		next := "n next"
		if f.fromCheck {
			next = "n back to check"
		}
		if f.detected {
			return []string{"enter add with this port", "a by hand", next}
		}
		return []string{"a by hand", next}
	case stepBindings:
		if f.targets {
			return []string{"b bindings", "n next"}
		}
		return []string{"n next"}
	case stepCheck:
		switch f.phase {
		case checkRunning:
			return []string{"l logs"}
		case checkFailed:
			if f.canFix {
				return []string{"t install", "s servers", "c check again", "l logs", "f fix with Claude", "n finish"}
			}
			return []string{"t install", "s servers", "c check again", "l logs", "n finish"}
		case checkConfirm:
			return []string{"y discard and check again", "n keep"}
		}
		return []string{"y check", "i install only", "n skip"}
	}
	return []string{"enter close"}
}

// escLabel is what esc does on a card — the walk stops everywhere but on
// the path field, the forms that reopen from the check card, and a check
// still running.
func escLabel(s step, f facts) string {
	switch {
	case s == stepFinish:
		return "esc close"
	case s == stepSource && f.adopting:
		return "esc back to url"
	case f.fromCheck && (s == stepInstall || s == stepServers):
		return "esc back to check"
	case s == stepCheck && f.phase == checkRunning:
		return "esc leaves it running"
	case s == stepCheck && f.phase == checkConfirm:
		return "esc keep"
	}
	return "esc stop"
}

// cliFor names the command a card stands for. Pure.
func cliFor(s step, name string, f facts) string {
	switch s {
	case stepSource:
		if f.adopting {
			return "crew add project <name> --path=<dir>"
		}
		return "crew add project <name> <url>"
	case stepInstall:
		return fmt.Sprintf("crew add project %s --setup=<cmd> --env-cmd=<cmd>", name)
	case stepServers:
		return fmt.Sprintf("crew dev setup %s --apply --port=<port> · crew dev add %s --name --port --cmd [--dir]", name, name)
	case stepBindings:
		return fmt.Sprintf("crew add binding %s[/<server>] --var=<VAR> --url=<proj>  ·  --scan --apply", name)
	case stepCheck:
		if f.phase == checkFailed {
			return fmt.Sprintf("crew fix check/%s · crew check project %s", name, name)
		}
		return fmt.Sprintf("crew check project %s [--no-smoke] --wait", name)
	}
	return ""
}

// nameFromURL is the project name a URL suggests: the last segment of
// the repo it names, with .git and a trailing slash already folded by
// RepoKey — one URL grammar, not a second one. Pure; "" for "".
func nameFromURL(url string) string {
	key := exec.RepoKey(url)
	if key == "" {
		return ""
	}
	base := path.Base(key)
	if base == "/" || base == "." {
		return ""
	}
	return base
}

// validName is the rule the whole walk needs of a name: the pool's, and
// the ref's — the check at the last step answers to check/<name> and
// would refuse a "--" after the clone had landed under the name.
func validName(name string) error {
	if err := project.ValidateName(name); err != nil {
		return err
	}
	if err := workspace.ValidateName("worktree", name); err != nil {
		return fmt.Errorf("'%s' cannot be checked: %w", name, err)
	}
	return nil
}

// serverRows lists what is recorded, one server per row. Pure.
func serverRows(p project.Project) []string {
	var rows []string
	for _, ds := range p.DevServers {
		row := fmt.Sprintf("%s :%d  %s", ds.Name, ds.Port, ds.Command)
		if ds.Dir != "" {
			row += "  dir:" + ds.Dir
		}
		rows = append(rows, row)
	}
	return rows
}

// bindingRows lists what is bound, label then template. Pure.
func bindingRows(p project.Project) []string {
	width := 0
	for _, b := range p.Bindings {
		width = max(width, len(b.Label()))
	}
	var rows []string
	for _, b := range p.Bindings {
		rows = append(rows, fmt.Sprintf("%-*s  %s", width, b.Label(), b.Value))
	}
	return rows
}

// targetRows lists the targets as the token that names each: the project
// alone when it has one server, project/server otherwise. Pure.
func targetRows(targets []project.Project) []string {
	var rows []string
	for _, p := range targets {
		for _, ds := range p.DevServers {
			token := "{{" + p.Name + "}}"
			if len(p.DevServers) > 1 {
				token = "{{" + p.Name + "/" + ds.Name + "}}"
			}
			rows = append(rows, fmt.Sprintf("%-32s %s :%d", token, ds.Name, ds.Port))
		}
	}
	return rows
}

// targetsFor is what a binding of proj could point at: every other
// project with servers. Pure.
func targetsFor(pool []project.Project, proj string) []project.Project {
	var out []project.Project
	for _, p := range project.WithDevServers(pool) {
		if p.Name != proj {
			out = append(out, p)
		}
	}
	return out
}

// verdict is what the check step ended with, as the finish card says it.
type verdict int

const (
	verdictNone verdict = iota
	verdictPassed
	verdictInstallOnly
	verdictFailed
	verdictRunning // stopped while the runner was alive
)

func (v verdict) line(name string) string {
	switch v {
	case verdictPassed:
		return "✓ reproduces from nothing — target removed"
	case verdictInstallOnly:
		return "✓ install — servers not smoked"
	case verdictFailed:
		return fmt.Sprintf("✗ kept with its evidence — crew fix check/%s", name)
	case verdictRunning:
		return fmt.Sprintf("still running — crew setup status check/%s", name)
	}
	return "not run — crew check project " + name
}

// finishCard is everything the closing card says. Pure over its fields.
type finishCard struct {
	Project   project.Project
	Remote    string
	Verdict   verdict
	StoppedAt step // stepFinish when the walk completed
}

// resumeAll is every key crew project has for what the walk records.
const resumeAll = "t setup  e env cmd  s servers  b bindings"

// resumeKeys names, per piece the walk did not reach, where crew project
// picks it up. Pure.
func (c finishCard) resumeKeys() string {
	if c.StoppedAt == stepFinish {
		return ""
	}
	var keys []string
	if c.StoppedAt <= stepInstall {
		keys = append(keys, "t setup", "e env cmd")
	}
	if c.StoppedAt <= stepServers {
		keys = append(keys, "s servers")
	}
	if c.StoppedAt <= stepBindings {
		keys = append(keys, "b bindings")
	}
	return strings.Join(keys, "  ")
}

func orNone(s string) string {
	if s == "" {
		return "—"
	}
	return s
}

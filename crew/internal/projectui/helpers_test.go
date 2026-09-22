package projectui

import (
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// One URL grammar: the name is the last segment of what RepoKey folds.
func TestNameFromURL(t *testing.T) {
	for url, want := range map[string]string{
		"https://github.com/example/store-api.git": "store-api",
		"git@github.com:example/store-api.git":     "store-api",
		"ssh://git@github.com/example/signals":     "signals",
		"ssh://git@host:2222/example/admin.git":    "admin",
		"file:///tmp/remotes/checkout-api.git":     "checkout-api",
		"https://github.com/example/infra-ops/":    "infra-ops",
		"/tmp/code/store-front":                    "store-front",
		"":                                         "",
	} {
		if got := nameFromURL(url); got != want {
			t.Errorf("nameFromURL(%q) = %q, want %q", url, got, want)
		}
	}
}

// The key line and the handler read one table — every situation pinned.
func TestKeysFor(t *testing.T) {
	for _, tt := range []struct {
		step step
		f    facts
		want string
	}{
		{stepSource, facts{}, "enter clone  tab name  ctrl+p adopt a path"},
		{stepSource, facts{adopting: true}, "enter adopt  tab name"},
		{stepInstall, facts{}, "tab next  enter save"},
		{stepInstall, facts{fromCheck: true}, "tab next  enter save"},
		{stepServers, facts{detected: true}, "enter add with this port  a by hand  n next"},
		{stepServers, facts{}, "a by hand  n next"},
		{stepServers, facts{fromCheck: true}, "a by hand  n back to check"},
		{stepServers, facts{detected: true, fromCheck: true}, "enter add with this port  a by hand  n back to check"},
		{stepBindings, facts{targets: true}, "b bindings  n next"},
		{stepBindings, facts{}, "n next"},
		{stepCheck, facts{}, "y check  i install only  n skip"},
		{stepCheck, facts{phase: checkRunning}, "l logs"},
		{stepCheck, facts{phase: checkFailed, canFix: true}, "t install  s servers  c check again  l logs  f fix with Claude  n finish"},
		{stepCheck, facts{phase: checkFailed}, "t install  s servers  c check again  l logs  n finish"},
		{stepCheck, facts{phase: checkConfirm}, "y discard and check again  n keep"},
		{stepFinish, facts{}, "enter close"},
	} {
		if got := strings.Join(keysFor(tt.step, tt.f), "  "); got != tt.want {
			t.Errorf("keysFor(%s, %+v) = %q, want %q", tt.step.label(), tt.f, got, tt.want)
		}
	}
	for _, tt := range []struct {
		step step
		f    facts
		want string
	}{
		{stepSource, facts{}, "esc stop"},
		{stepSource, facts{adopting: true}, "esc back to url"},
		{stepInstall, facts{fromCheck: true}, "esc back to check"},
		{stepServers, facts{fromCheck: true}, "esc back to check"},
		{stepCheck, facts{phase: checkRunning}, "esc leaves it running"},
		{stepCheck, facts{phase: checkConfirm}, "esc keep"},
		{stepFinish, facts{}, "esc close"},
	} {
		if got := escLabel(tt.step, tt.f); got != tt.want {
			t.Errorf("escLabel(%s, %+v) = %q, want %q", tt.step.label(), tt.f, got, tt.want)
		}
	}
}

// verdictFor is the whole pass / install-only / failed / alive matrix.
func TestVerdictFor(t *testing.T) {
	row := func(state workspace.ProjectState) workspace.Status {
		return workspace.Status{Projects: []workspace.ProjectStatus{{Project: "store-api", State: state}}}
	}
	for _, tt := range []struct {
		state workspace.ProjectState
		smoke bool
		phase checkPhase
		v     verdict
	}{
		{workspace.StateRunning, true, checkRunning, verdictNone},
		{workspace.StateStarting, false, checkRunning, verdictNone},
		{workspace.StateOK, true, checkPassed, verdictPassed},
		{workspace.StateOK, false, checkPassed, verdictInstallOnly},
		{workspace.StateFailed, true, checkFailed, verdictFailed},
		{workspace.StateInterrupted, false, checkFailed, verdictFailed},
	} {
		if phase, v := verdictFor(row(tt.state), tt.smoke); phase != tt.phase || v != tt.v {
			t.Errorf("%s smoke=%v → %v %v, want %v %v", tt.state, tt.smoke, phase, v, tt.phase, tt.v)
		}
	}
}

func TestValidName(t *testing.T) {
	if err := validName("store-api"); err != nil {
		t.Error(err)
	}
	if err := validName("a--b"); err == nil || !strings.Contains(err.Error(), "'a--b' cannot be checked") {
		t.Errorf("-- must be refused before the clone: %v", err)
	}
	if err := validName("Store"); err == nil {
		t.Error("the pool's charset rule applies")
	}
}

func TestRows(t *testing.T) {
	p := project.Project{
		Name:       "store-api",
		DevServers: []project.DevServer{{Name: "api", Port: 8000, Command: "uvicorn app --port $PORT"}, {Name: "worker", Port: 8001, Command: "celery", Dir: "worker"}},
		Bindings:   []project.Binding{{Var: "SIGNALS_URL", Value: "{{signals}}"}, {Var: "DB", Server: "worker", Value: "{{infra-ops/db.host}}"}, {Var: "PORT", Value: "{{store-api.port}}"}},
	}
	if got := strings.Join(serverRows(p), "|"); got != "api :8000  uvicorn app --port $PORT|worker :8001  celery  dir:worker" {
		t.Errorf("serverRows = %q", got)
	}
	if got := strings.Join(bindingRows(p), "|"); got != "SIGNALS_URL  {{signals}}|DB (worker)  {{infra-ops/db.host}}|PORT         {{store-api.port}}" {
		t.Errorf("bindingRows = %q", got)
	}
	pool := []project.Project{p, {Name: "signals", DevServers: []project.DevServer{{Name: "signals", Port: 4000}}}, {Name: "docs"}}
	if got := targetsFor(pool, "store-api"); len(got) != 1 || got[0].Name != "signals" {
		t.Errorf("targetsFor = %+v — never the project itself, never one without servers", got)
	}
	// A target with one server is named bare; with more, per server.
	if got := strings.Join(targetRows(append(targetsFor(pool, "store-api"), p)), "|"); got != "{{signals}}                      signals :4000|{{store-api/api}}                api :8000|{{store-api/worker}}             worker :8001" {
		t.Errorf("targetRows = %q", got)
	}
	// A server that loses its port leaves the list, and the one left is
	// named bare — the token the save accepts.
	p.DevServers[1].Port = 0
	if got := strings.Join(targetRows([]project.Project{p}), "|"); got != "{{store-api}}                    api :8000" {
		t.Errorf("targetRows with a port-less server = %q", got)
	}
}

func TestFinishCard_ResumeKeysAndVerdicts(t *testing.T) {
	for _, tt := range []struct {
		at   step
		want string
	}{
		{stepInstall, "t setup  e env cmd  s servers  b bindings"},
		{stepServers, "s servers  b bindings"},
		{stepBindings, "b bindings"},
		{stepCheck, ""},
		{stepFinish, ""},
	} {
		if got := (finishCard{StoppedAt: tt.at}).resumeKeys(); got != tt.want {
			t.Errorf("stopped at %s → %q, want %q", tt.at.label(), got, tt.want)
		}
	}
	for v, want := range map[verdict]string{
		verdictNone:        "not run — crew check project store-api",
		verdictPassed:      "✓ reproduces from nothing — target removed",
		verdictInstallOnly: "✓ install — servers not smoked",
		verdictFailed:      "✗ kept with its evidence — crew fix check/store-api",
		verdictRunning:     "still running — crew setup status check/store-api",
	} {
		if got := v.line("store-api"); got != want {
			t.Errorf("verdict %d = %q, want %q", v, got, want)
		}
	}
}

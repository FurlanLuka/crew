package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
	crewexec "github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/transfer"
	"github.com/FurlanLuka/crew/crew/internal/trash"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// cliConfig points every crew path at a temp dir, as the commands see it.
func cliConfig(t *testing.T) string {
	t.Helper()
	tmp := t.TempDir()
	prev := []string{config.ConfigDir, config.WorkspacesDir, config.ProjectsDir, config.TrashDir}
	config.ConfigDir = tmp
	config.WorkspacesDir = filepath.Join(tmp, "workspaces")
	config.ProjectsDir = filepath.Join(tmp, "projects")
	config.TrashDir = filepath.Join(tmp, "trash")
	os.MkdirAll(config.WorkspacesDir, 0o755)
	trash.DisableSweepForTest(t)
	t.Cleanup(func() {
		config.ConfigDir, config.WorkspacesDir, config.ProjectsDir, config.TrashDir = prev[0], prev[1], prev[2], prev[3]
	})
	return tmp
}

// runCLI runs one command function with os.Args set and returns what it
// printed on stdout and on the human stream.
func runCLI(t *testing.T, args []string, fn func()) (stdout, narration string) {
	t.Helper()
	prevArgs, prevOut, prevHuman := os.Args, os.Stdout, human
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	var narr bytes.Buffer
	os.Args, os.Stdout, human = append([]string{"crew"}, args...), w, &narr
	done := make(chan string)
	go func() {
		data, _ := io.ReadAll(r)
		done <- string(data)
	}()
	defer func() { os.Args, os.Stdout, human = prevArgs, prevOut, prevHuman }()
	fn()
	w.Close()
	return <-done, narr.String()
}

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	if _, err := crewexec.RunGitCommand(dir, append([]string{"-c", "user.email=a@b", "-c", "user.name=t"}, args...)...); err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
}

// crew workspace and crew project are tables now, with the way to the page.
func TestRemovedTUIEntryPoints(t *testing.T) {
	cliConfig(t)
	project.Add(project.Project{Name: "store-api", Path: "/repos/store-api"})
	workspace.Save(&workspace.Workspace{Name: "store-front", Projects: []workspace.WorkspaceProject{{Name: "store-api"}}, Worktrees: []workspace.Worktree{{Name: "main"}}})

	out, narr := runCLI(t, []string{"project"}, func() { cmdRemovedTUI("project") })
	if out != "store-api\t/repos/store-api\t-\n" || narr != configureInBrowser+"\n" {
		t.Errorf("crew project: %q / %q", out, narr)
	}
	out, narr = runCLI(t, []string{"workspace"}, func() { cmdRemovedTUI("workspace") })
	if out != "store-front\t1 project\tmain\n" || narr != configureInBrowser+"\n" {
		t.Errorf("crew workspace: %q / %q", out, narr)
	}
}

// The trash flow the settings page had, as the CLI has it: what is
// clearing, then an empty that frees it.
func TestTrashEmptyFlow(t *testing.T) {
	cliConfig(t)
	out, _ := runCLI(t, []string{"trash"}, cmdTrash)
	if out != config.TrashDir+"\tempty\n" {
		t.Errorf("empty trash: %q", out)
	}
	dir := filepath.Join(config.WorkspacesDir, "ws", "wrk1")
	os.MkdirAll(filepath.Join(dir, "node_modules"), 0o755)
	os.WriteFile(filepath.Join(dir, "node_modules", "big.js"), bytes.Repeat([]byte("x"), 4096), 0o644)
	if _, err := trash.Put(dir); err != nil {
		t.Fatal(err)
	}
	out, _ = runCLI(t, []string{"trash"}, cmdTrash)
	if !strings.HasPrefix(out, config.TrashDir+"\t") || !strings.Contains(out, "1 entry\tclearing in background — crew trash empty deletes now") {
		t.Errorf("trash with an entry: %q", out)
	}
	out, narr := runCLI(t, []string{"trash", "empty"}, cmdTrash)
	if !strings.HasPrefix(out, "Emptied "+config.TrashDir) || !strings.Contains(narr, "Emptying") {
		t.Errorf("empty: %q / %q", out, narr)
	}
	if _, entries := trash.Size(); entries != 0 {
		t.Errorf("%d entries left", entries)
	}
}

// export - writes the bundle to stdout and nothing else; import - reads it
// back from stdin, and its bare form is the plan.
func TestExportImportRoundTripOverStdio(t *testing.T) {
	tmp := cliConfig(t)
	repo := filepath.Join(tmp, "repos", "store-api")
	os.MkdirAll(repo, 0o755)
	git(t, repo, "init", "-q", "-b", "main")
	git(t, repo, "commit", "-q", "--allow-empty", "-m", "init")
	git(t, repo, "remote", "add", "origin", "git@github.com:example/store-api.git")
	project.Add(project.Project{Name: "store-api", Path: repo, Setup: "make"})
	workspace.Save(&workspace.Workspace{Name: "store-front", Projects: []workspace.WorkspaceProject{{Name: "store-api"}}, Worktrees: []workspace.Worktree{{Name: "main"}}})

	out, narr := runCLI(t, []string{"export", "-"}, cmdExport)
	if !strings.HasPrefix(out, "{\n") || !strings.Contains(narr, "Wrote the bundle to stdout — 1 project, 1 workspace") {
		t.Fatalf("export -: %q / %q", out, narr)
	}
	b, err := transfer.Decode("stdin", []byte(out))
	if err != nil || len(b.Projects) != 1 || b.Projects[0].Remote != "git@github.com:example/store-api.git" || len(b.Workspaces) != 1 {
		t.Fatalf("bundle = %+v, %v", b, err)
	}

	plan, _ := importPlanFrom(t, out)
	if !strings.HasPrefix(plan, "project\tstore-api\texists\t"+repo+"\n") {
		t.Errorf("import - plan: %q", plan)
	}

	// Another machine: nothing in the pool, so the project is a clone into
	// crew's projects dir and the workspace waits on it.
	cliConfig(t)
	plan, _ = importPlanFrom(t, out)
	want := "project\tstore-api\tclone\t" + project.ClonePath("store-api") + "\n" +
		"workspace\tstore-front\tneeds\tstore-api\n"
	if plan != want {
		t.Errorf("import - plan into an empty pool:\n%q\nwant\n%q", plan, want)
	}
}

// importPlanFrom runs crew import - with bundle on stdin.
func importPlanFrom(t *testing.T, bundle string) (string, string) {
	t.Helper()
	prevIn := os.Stdin
	r, w, _ := os.Pipe()
	w.WriteString(bundle)
	w.Close()
	os.Stdin = r
	defer func() { os.Stdin = prevIn }()
	return runCLI(t, []string{"import", "-"}, cmdImport)
}

// The base table every worktree creation opens with, and --pull bringing a
// stale base up to date first.
func TestPrintBases_StaleThenPulled(t *testing.T) {
	if _, err := osexec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	tmp := cliConfig(t)
	seed := filepath.Join(tmp, "seed")
	os.MkdirAll(seed, 0o755)
	git(t, seed, "init", "-q", "-b", "main")
	git(t, seed, "commit", "-q", "--allow-empty", "-m", "init")
	remote := filepath.Join(tmp, "remote.git")
	git(t, tmp, "clone", "-q", "--bare", seed, remote)
	clone := filepath.Join(tmp, "repos", "store-api")
	git(t, tmp, "clone", "-q", remote, clone)
	git(t, seed, "remote", "add", "origin", remote)
	git(t, seed, "commit", "-q", "--allow-empty", "-m", "upstream")
	git(t, seed, "push", "-q", "origin", "main")
	project.Add(project.Project{Name: "store-api", Path: clone})
	ws := &workspace.Workspace{Name: "store-front", Projects: []workspace.WorkspaceProject{{Name: "store-api"}}}

	_, narr := runCLI(t, nil, func() {
		printBases(ws, false, "crew add worktree store-front/wrk2 --pull fast-forwards the local bases first.")
	})
	if !strings.Contains(narr, "Branching from") || !strings.Contains(narr, "1 behind origin/main") || !strings.Contains(narr, "--pull fast-forwards the local bases first.") {
		t.Errorf("stale table:\n%s", narr)
	}
	_, narr = runCLI(t, nil, func() { printBases(ws, true, "unused") })
	if !strings.Contains(narr, "Pulling latest…") || !strings.Contains(narr, "up to date") || strings.Contains(narr, "unused") {
		t.Errorf("pulled table:\n%s", narr)
	}
}

// setup logs --json counts lines after cleaning the whole log: a shell's
// prompt redraws after the last real line clean to nothing, so a tail read
// first would come back empty.
func TestSetupLogsJSONCleansTheWholeLogBeforeCounting(t *testing.T) {
	cliConfig(t)
	project.Add(project.Project{Name: "api", Path: "/repos/api"})
	workspace.Save(&workspace.Workspace{Name: "ws", Projects: []workspace.WorkspaceProject{{Name: "api"}}, Worktrees: []workspace.Worktree{{Name: "wt"}}})
	ref := workspace.Ref{Workspace: "ws", Worktree: "wt"}
	logFile := workspace.RunnerLogFile(ref, "api")
	os.MkdirAll(filepath.Dir(logFile), 0o755)
	if err := os.WriteFile(logFile, []byte("a\nb\nc\n\x1b[?2004h% \n\x1b[?2004h% \n"), 0o644); err != nil {
		t.Fatal(err)
	}

	args, isJSON := extractFlag([]string{"setup", "logs", "ws/wt", "api", "--lines=2", "--json"}, "--json")
	prevJSON := jsonOutput
	jsonOutput = isJSON
	t.Cleanup(func() { jsonOutput = prevJSON })
	out, _ := runCLI(t, args, cmdSetupLogs)

	var doc struct {
		Lines []string `json:"lines"`
	}
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("not JSON: %q (%v)", out, err)
	}
	if strings.Join(doc.Lines, ",") != "b,c" {
		t.Errorf("lines = %q, want [b c]", doc.Lines)
	}
}

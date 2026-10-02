package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

func TestMigrationRows(t *testing.T) {
	empty, _ := json.Marshal(migrationRows(&workspace.MigrationPlan{}))
	if string(empty) != "[]" {
		t.Errorf("no moves = %s, want []", empty)
	}

	plan := &workspace.MigrationPlan{Moves: []workspace.MigrationMove{
		{OldWorkspace: "store-front-wrk1", Ref: workspace.Ref{Workspace: "store-front", Worktree: "wrk1"}},
	}}
	got, _ := json.Marshal(migrationRows(plan))
	want := `[{"workspace":"store-front-wrk1","ref":"store-front/wrk1"}]`
	if string(got) != want {
		t.Errorf("rows = %s, want %s", got, want)
	}
}

// Under --json stdout is the one document and the plan text is narration.
func TestMigrateYesJSON(t *testing.T) {
	cliConfig(t)
	prev := jsonOutput
	jsonOutput = true
	t.Cleanup(func() { jsonOutput = prev })

	stdout, narration := runCLI(t, []string{"migrate", "--yes"}, cmdMigrate)
	var doc map[string]int
	if err := json.Unmarshal([]byte(stdout), &doc); err != nil || len(doc) != 1 || doc["migrated"] != 0 {
		t.Errorf("stdout = %q (%v), want {\"migrated\":0}", stdout, err)
	}
	if !strings.Contains(narration, "Nothing to migrate") {
		t.Errorf("narration = %q", narration)
	}

	// A flat workspace with a direct member moves without touching git.
	project.Add(project.Project{Name: "store-api", Path: "/repos/store-api"})
	workspace.Save(&workspace.Workspace{Name: "store-front", Projects: []workspace.WorkspaceProject{{Name: "store-api", Mode: workspace.ModeDirect}}})
	stdout, narration = runCLI(t, []string{"migrate", "--yes"}, cmdMigrate)
	if err := json.Unmarshal([]byte(stdout), &doc); err != nil || doc["migrated"] != 1 {
		t.Errorf("stdout = %q (%v), want {\"migrated\":1}", stdout, err)
	}
	if !strings.Contains(narration, "store-front") || !strings.Contains(narration, "direct — not moved") {
		t.Errorf("narration = %q", narration)
	}
}

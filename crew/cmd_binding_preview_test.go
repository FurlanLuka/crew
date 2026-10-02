package main

import (
	"reflect"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/project"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// What --dry-run refuses is what the add refuses: the draft's rules, the
// malformed template's reason before a missing var's.
func TestDryRunDoc_Refusals(t *testing.T) {
	useTempConfig(t)
	project.Add(project.Project{Name: "store-api", Path: "/repos/store-api", DevServers: []project.DevServer{{Name: "api", Port: 3000}}})
	project.Add(project.Project{Name: "store-front", Path: "/repos/store-front"})
	tests := []struct {
		name    string
		draft   project.Binding
		wantErr string
	}{
		{"both", project.Binding{Var: "A", Value: "{{store-api}}"}, ""},
		{"empty", project.Binding{}, "is not a valid environment variable name"},
		{"var only", project.Binding{Var: "A"}, "has no value"},
		{"invalid var", project.Binding{Var: "1A", Value: "{{store-api}}"}, "'1A' is not a valid environment variable name"},
		{"malformed", project.Binding{Var: "A", Value: "{{store-api.foo}}"}, "a server is written"},
		{"malformed before no var", project.Binding{Var: "", Value: "{{store-api.foo}}"}, "a server is written"},
		{"unknown project", project.Binding{Var: "A", Value: "{{nope}}"}, "no project 'nope' in the pool"},
		{"unknown scope", project.Binding{Var: "A", Value: "{{store-api}}", Server: "web"}, "has no dev server 'web'"},
	}
	for _, tt := range tests {
		owner := "store-front"
		if tt.draft.Server != "" {
			owner = "store-api"
		}
		doc := dryRunDoc(tt.draft, project.ValidateBinding(owner, tt.draft), nil)
		if tt.wantErr == "" && doc.Error != "" {
			t.Errorf("%s: unexpected error %q", tt.name, doc.Error)
		}
		if tt.wantErr != "" && !strings.Contains(doc.Error, tt.wantErr) {
			t.Errorf("%s: error = %q, want %q", tt.name, doc.Error, tt.wantErr)
		}
		if doc.Previews == nil {
			t.Errorf("%s: previews must be a list", tt.name)
		}
	}
}

func TestPreviewCellAndLine(t *testing.T) {
	for name, tt := range map[string]struct {
		previews []workspace.BindingPreview
		want     string
	}{
		"none":     {nil, "→ no worktree to check against"},
		"resolved": {[]workspace.BindingPreview{{Ref: "ws/wrk1", Value: "http://localhost:1", Resolved: true, Running: true}}, "→ http://localhost:1  in ws/wrk1"},
		"stopped":  {[]workspace.BindingPreview{{Ref: "ws/wrk1", Value: "http://localhost:1", Resolved: true}}, "→ http://localhost:1  in ws/wrk1 · stopped"},
		"first resolved wins": {[]workspace.BindingPreview{
			{Ref: "ws/a", Detail: "no dev server"},
			{Ref: "ws/b", Value: "http://localhost:2", Resolved: true, Running: true},
		}, "→ http://localhost:2  in ws/b"},
		"left alone": {[]workspace.BindingPreview{{Ref: "ws/a", Detail: "store-api has no server db"}}, "→ left alone  store-api has no server db"},
	} {
		if got := previewCell(tt.previews); got != tt.want {
			t.Errorf("%s: %q, want %q", name, got, tt.want)
		}
	}
	if got := previewLine(workspace.BindingPreview{Ref: "ws/a", Detail: "no dev server"}); got != "ws/a\tleft alone — no dev server\tstopped" {
		t.Errorf("line = %q", got)
	}
}

func TestPreviewRows_JoinByIdentity(t *testing.T) {
	rows := []bindingRow{{Var: "API_URL", Value: "{{store-api}}"}, {Var: "API_URL", Server: "web", Value: "{{store-api}}"}}
	scoped := []workspace.BindingPreview{{Ref: "ws/main", Value: "http://localhost:9", Resolved: true}}
	got := previewRows(rows, map[dev.BindingKey][]workspace.BindingPreview{{Var: "API_URL", Server: "web"}: scoped})
	if len(got) != 2 || len(got[0].Previews) != 0 || got[0].Previews == nil || !reflect.DeepEqual(got[1].Previews, scoped) {
		t.Errorf("rows = %+v", got)
	}
}

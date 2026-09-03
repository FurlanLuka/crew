package workspace

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/project"
)

func TestParseRef(t *testing.T) {
	tests := []struct {
		input   string
		want    Ref
		wantErr string
	}{
		{input: "phone-speak", want: Ref{Workspace: "phone-speak"}},
		{input: "phone-speak/wrk2", want: Ref{Workspace: "phone-speak", Worktree: "wrk2"}},
		{input: "a/b/c", wantErr: "expected <workspace>"},
		{input: "", wantErr: "empty"},
		{input: "ws/", wantErr: "worktree name is empty"},
		{input: "/wt", wantErr: "workspace name is empty"},
		{input: "Phone-Speak", wantErr: "invalid"},
		{input: "ws/WRK2", wantErr: "invalid"},

		// "--" is the slug separator: a workspace literally named
		// "phone-speak--wrk2" would collide with phone-speak/wrk2 across the
		// route file, log dir, tmux session and subdomain at once.
		{input: "phone-speak--wrk2", wantErr: "reserved"},
		{input: "ws/wrk--2", wantErr: "reserved"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got, err := ParseRef(tt.input)

			if tt.wantErr != "" {
				if err == nil {
					t.Fatalf("ParseRef(%q) = %+v, want error mentioning %q", tt.input, got, tt.wantErr)
				}
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Errorf("error = %q, want it to mention %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseRef(%q): %v", tt.input, err)
			}
			if got != tt.want {
				t.Errorf("ParseRef(%q) = %+v, want %+v", tt.input, got, tt.want)
			}
		})
	}
}

func TestRefSlugRoundTrip(t *testing.T) {
	tests := []struct {
		ref  Ref
		slug dev.Slug
	}{
		{Ref{Workspace: "phone-speak", Worktree: "wrk2"}, "phone-speak--wrk2"},
		{Ref{Workspace: "mumbo", Worktree: "main"}, "mumbo--main"},
		{Ref{Workspace: "legacy"}, "legacy"},
	}

	for _, tt := range tests {
		t.Run(string(tt.slug), func(t *testing.T) {
			if got := tt.ref.Slug(); got != tt.slug {
				t.Errorf("Slug = %q, want %q", got, tt.slug)
			}
			if got := ParseSlug(tt.slug); got != tt.ref {
				t.Errorf("ParseSlug(%q) = %+v, want %+v", tt.slug, got, tt.ref)
			}
		})
	}
}

func TestRefString(t *testing.T) {
	if got := (Ref{Workspace: "phone-speak", Worktree: "wrk2"}).String(); got != "phone-speak/wrk2" {
		t.Errorf("String = %q, want phone-speak/wrk2", got)
	}
	if got := (Ref{Workspace: "legacy"}).String(); got != "legacy" {
		t.Errorf("String = %q, want legacy", got)
	}
}

func TestResolve_NestsPathsUnderWorktree(t *testing.T) {
	setupTestConfig(t)
	project.Add(project.Project{Name: "api", Path: "/canonical/api"})
	Save(&Workspace{
		Name:      "ws",
		Projects:  []WorkspaceProject{{Name: "api"}},
		Worktrees: []Worktree{{Name: "wrk1"}, {Name: "wrk2"}},
	})

	res, err := Resolve(Ref{Workspace: "ws", Worktree: "wrk2"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	want := filepath.Join(config.WorkspacesDir, "ws", "wrk2", "api")
	if res.Projects[0].Path != want {
		t.Errorf("path = %q, want %q", res.Projects[0].Path, want)
	}
	if res.Slug != "ws--wrk2" {
		t.Errorf("slug = %q, want ws--wrk2", res.Slug)
	}
}

// A workspace written before worktrees existed keeps its flat layout rather
// than resolving to a directory that was never created.
func TestResolve_LegacyWorkspaceStaysFlat(t *testing.T) {
	setupTestConfig(t)
	project.Add(project.Project{Name: "api", Path: "/canonical/api"})
	Save(&Workspace{Name: "legacy", Projects: []WorkspaceProject{{Name: "api"}}})

	res, err := Resolve(Ref{Workspace: "legacy"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	want := filepath.Join(config.WorkspacesDir, "legacy", "api")
	if res.Projects[0].Path != want {
		t.Errorf("path = %q, want the flat pre-worktree layout %q", res.Projects[0].Path, want)
	}
	if res.Slug != "legacy" {
		t.Errorf("slug = %q, want legacy", res.Slug)
	}
}

func TestResolve_BareRefNeedsDisambiguation(t *testing.T) {
	setupTestConfig(t)
	Save(&Workspace{
		Name:      "ws",
		Worktrees: []Worktree{{Name: "wrk1"}, {Name: "wrk2"}},
	})

	_, err := Resolve(Ref{Workspace: "ws"})
	if err == nil {
		t.Fatal("bare ref with two worktrees should not resolve")
	}
	for _, want := range []string{"wrk1", "wrk2", "ws/<worktree>"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q should mention %q", err, want)
		}
	}
}

func TestResolve_BareRefResolvesSingleWorktree(t *testing.T) {
	setupTestConfig(t)
	Save(&Workspace{Name: "ws", Worktrees: []Worktree{{Name: "only"}}})

	res, err := Resolve(Ref{Workspace: "ws"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if res.Ref.Worktree != "only" {
		t.Errorf("worktree = %q, want only", res.Ref.Worktree)
	}
}

func TestResolve_UnknownWorktree(t *testing.T) {
	setupTestConfig(t)
	Save(&Workspace{Name: "ws", Worktrees: []Worktree{{Name: "wrk1"}}})

	if _, err := Resolve(Ref{Workspace: "ws", Worktree: "nope"}); err == nil {
		t.Fatal("unknown worktree should not resolve")
	}
}

func TestResolve_DirectProjectKeepsCanonicalPath(t *testing.T) {
	setupTestConfig(t)
	project.Add(project.Project{Name: "api", Path: "/canonical/api"})
	Save(&Workspace{
		Name:      "ws",
		Projects:  []WorkspaceProject{{Name: "api", Mode: ModeDirect}},
		Worktrees: []Worktree{{Name: "wrk1"}},
	})

	res, err := Resolve(Ref{Workspace: "ws", Worktree: "wrk1"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if res.Projects[0].Path != "/canonical/api" {
		t.Errorf("path = %q, want the canonical checkout", res.Projects[0].Path)
	}
}

// A project removed from the pool leaves a workspace entry behind; resolution
// falls back to the worktree path rather than failing the whole workspace.
func TestResolve_MissingPoolEntryFallsBack(t *testing.T) {
	setupTestConfig(t)
	Save(&Workspace{
		Name:      "ws",
		Projects:  []WorkspaceProject{{Name: "ghost"}},
		Worktrees: []Worktree{{Name: "wrk1"}},
	})

	res, err := Resolve(Ref{Workspace: "ws", Worktree: "wrk1"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if want := WorktreePath(Ref{Workspace: "ws", Worktree: "wrk1"}, "ghost"); res.Projects[0].Path != want {
		t.Errorf("path = %q, want %q", res.Projects[0].Path, want)
	}
	if len(res.Projects[0].DevServers) != 0 {
		t.Errorf("DevServers = %+v, want none", res.Projects[0].DevServers)
	}
}

func TestResolve_CarriesWorktreeOverrides(t *testing.T) {
	setupTestConfig(t)
	Save(&Workspace{
		Name: "ws",
		Worktrees: []Worktree{
			{Name: "wrk1"},
			{Name: "wrk2", Overrides: map[string]string{"SPEAK_API_URL": "https://dev"}},
		},
	})

	res, err := Resolve(Ref{Workspace: "ws", Worktree: "wrk2"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if res.Overrides["SPEAK_API_URL"] != "https://dev" {
		t.Errorf("overrides = %+v, want the wrk2 override", res.Overrides)
	}

	res, _ = Resolve(Ref{Workspace: "ws", Worktree: "wrk1"})
	if len(res.Overrides) != 0 {
		t.Errorf("wrk1 overrides = %+v, want none — overrides are per worktree", res.Overrides)
	}
}

// git refuses to check one branch out into two worktrees, so the worktree has
// to be part of the branch name.
func TestBranchName_DistinctPerWorktree(t *testing.T) {
	a := BranchName(Ref{Workspace: "phone-speak", Worktree: "wrk1"}, "ai-tutor-api")
	b := BranchName(Ref{Workspace: "phone-speak", Worktree: "wrk2"}, "ai-tutor-api")

	if a == b {
		t.Fatalf("both worktrees produced branch %q", a)
	}
	if a != "crew/phone-speak/wrk1/ai-tutor-api" {
		t.Errorf("BranchName = %q, want crew/phone-speak/wrk1/ai-tutor-api", a)
	}
	if got := BranchName(Ref{Workspace: "legacy"}, "api"); got != "crew/legacy/api" {
		t.Errorf("legacy BranchName = %q, want crew/legacy/api", got)
	}
}

// The bug the first live run found: DevProjects built dev.DevProject without
// its bindings, so nothing ever resolved.
func TestDevProjects_CarriesBindings(t *testing.T) {
	setupTestConfig(t)
	project.Add(project.Project{
		Name: "ai-tutor-api", Path: "/p/tutor",
		Bindings: []project.Binding{{Var: "SPEAK_API_URL", Value: "{{url:speak-api}}"}},
	})
	Save(&Workspace{
		Name:      "ws",
		Projects:  []WorkspaceProject{{Name: "ai-tutor-api"}},
		Worktrees: []Worktree{{Name: "main"}},
	})

	res, err := Resolve(Ref{Workspace: "ws"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}

	projects := res.DevProjects()
	if len(projects) != 1 {
		t.Fatalf("got %d dev projects, want 1 — a project with bindings but no servers still resolves", len(projects))
	}
	if len(projects[0].Bindings) != 1 || projects[0].Bindings[0].Var != "SPEAK_API_URL" {
		t.Errorf("bindings = %+v, want SPEAK_API_URL carried through", projects[0].Bindings)
	}
}

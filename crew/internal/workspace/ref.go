package workspace

import (
	"fmt"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/dev"
)

// Ref names one worktree inside one workspace — "phone-speak/wrk2".
//
// A Ref is what the user types and what every command resolves against. It is
// pure data: parsing one never touches disk, so a caller can validate syntax
// before deciding whether the workspace exists.
type Ref struct {
	Workspace string
	Worktree  string
}

// ParseRef splits "<workspace>[/<worktree>]" into a Ref, validating both halves.
//
// A bare workspace leaves Worktree empty; resolving that to a concrete worktree
// needs the workspace on disk, so it happens in Resolve rather than here.
func ParseRef(s string) (Ref, error) {
	if s == "" {
		return Ref{}, fmt.Errorf("empty workspace reference")
	}

	parts := strings.Split(s, "/")
	if len(parts) > 2 {
		return Ref{}, fmt.Errorf("invalid reference '%s' — expected <workspace> or <workspace>/<worktree>", s)
	}

	ref := Ref{Workspace: parts[0]}
	if len(parts) == 2 {
		ref.Worktree = parts[1]
	}

	if err := ValidateName("workspace", ref.Workspace); err != nil {
		return Ref{}, err
	}
	if len(parts) == 2 {
		if err := ValidateName("worktree", ref.Worktree); err != nil {
			return Ref{}, err
		}
	}
	return ref, nil
}

// ValidateName enforces the naming rule shared by workspaces and worktrees.
//
// "--" is rejected specifically because it is the slug separator: a workspace
// literally named "phone-speak--wrk2" would collide with workspace phone-speak
// worktree wrk2 across the route file, log directory, tmux session and proxy
// subdomain simultaneously.
func ValidateName(kind, name string) error {
	if name == "" {
		return fmt.Errorf("%s name is empty", kind)
	}
	if !validWSName.MatchString(name) {
		return fmt.Errorf("%s name '%s' is invalid — only lowercase letters, digits, and hyphens allowed", kind, name)
	}
	if strings.Contains(name, "--") {
		return fmt.Errorf("%s name '%s' is invalid — '--' is reserved as the workspace/worktree separator", kind, name)
	}
	return nil
}

// Slug is the flat form used for route files, log directories, tmux sessions
// and proxy subdomains. A Ref with no worktree resolves to the bare workspace
// name — the pre-worktree layout, which crew still has to address until the
// workspace has been migrated.
func (r Ref) Slug() dev.Slug {
	if r.Worktree == "" {
		return dev.Slug(r.Workspace)
	}
	return dev.Slug(r.Workspace + "--" + r.Worktree)
}

// String renders the ref the way the user writes it.
func (r Ref) String() string {
	if r.Worktree == "" {
		return r.Workspace
	}
	return r.Workspace + "/" + r.Worktree
}

package project

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
)

var validServerName = regexp.MustCompile(`^[a-z0-9-]+$`)

// DevServer describes how to run a dev server for a project.
type DevServer struct {
	Name    string `json:"name"`
	Port    int    `json:"port"`
	Command string `json:"command"`
	Dir     string `json:"dir,omitempty"`
}

// Binding declares that this project needs Var set, and how to compute it.
//
// The edge lives on the project rather than the workspace because it comes from
// this project's own env schema: checkout-api needs store-api's URL in
// STORE_API_URL in every workspace it ever appears in. Declaring it per
// workspace means re-declaring the same edge everywhere and watching them drift.
//
// Value is a template; dev.ParseTokens is the grammar. Server narrows the
// binding to one of the project's dev servers — a monorepo's web app and its
// worker point at different siblings; empty is project-wide. See
// dev.BindingKey for what the two mean on one var.
type Binding struct {
	Var    string `json:"var"`
	Value  string `json:"value"`
	Server string `json:"server,omitempty"`
}

// Key is the binding's identity: (var, server).
func (b Binding) Key() dev.BindingKey { return dev.BindingKey{Var: b.Var, Server: b.Server} }

// Label is the binding as the editor and the import card show it.
func (b Binding) Label() string { return b.Key().Label() }

// Project is a global project entry (no role — role is workspace-specific).
type Project struct {
	Name       string      `json:"name"`
	Path       string      `json:"path,omitempty"`
	DevServers []DevServer `json:"dev_servers,omitempty"`
	Bindings   []Binding   `json:"bindings,omitempty"`
	// Setup is the command that installs a fresh checkout, when the lockfile
	// alone is not the answer — "make sync" for a repo that also pulls model
	// weights or needs registry auth. Replaces detection; mise still runs first.
	Setup string `json:"setup,omitempty"`
	// EnvCmd writes a fresh checkout's env files — "make get-env" for a repo
	// whose secrets come from sops or a vault. The copied .env is a stale
	// snapshot; this runs after the install, so a get-env that is a package
	// script or an installed tool has what it needs.
	EnvCmd string `json:"env_cmd,omitempty"`
}

// CrewOwned: the canonical checkout is a clone crew made under
// config.ProjectsDir — the one kind of project path crew may remove.
func CrewOwned(p Project) bool { return config.Under(p.Path, config.ProjectsDir) }

// ClonePath is where `crew add project <name> <url>` puts the clone.
func ClonePath(name string) string { return filepath.Join(config.ProjectsDir, name) }

// CloneDirTaken: something already sits where the clone would land — a
// dir or a file, either stops git. The one predicate for add and import;
// each words its own way out.
func CloneDirTaken(name string) bool {
	_, err := os.Stat(ClonePath(name))
	return err == nil
}

// CloneAllowed is CloneDirTaken as add project's refusal: never adopt what
// is there silently, name the two ways out.
func CloneAllowed(name string) error {
	if CloneDirTaken(name) {
		dir := ClonePath(name)
		return fmt.Errorf("%s already exists — crew add project %s --path=%s registers what is there, or delete it first", dir, name, dir)
	}
	return nil
}

// ValidateCheckoutDir: a path taken as a canonical checkout must be a
// directory that is here. The one check for add --path, SetPath and an
// import's adoption.
func ValidateCheckoutDir(path string) error {
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		return fmt.Errorf("'%s' is not a directory", path)
	}
	return nil
}

// RemoteOf is the project's identity: the origin its checkout points at,
// read when asked and never stored, so it cannot drift from the clone.
// "" for a repo without one — such a project cannot be cloned elsewhere.
func RemoteOf(p Project) string { return exec.OriginURL(p.Path) }

func poolFile() string {
	return filepath.Join(config.ConfigDir, "projects.json")
}

// List returns all projects from the global pool.
func List() ([]Project, error) {
	data, err := os.ReadFile(poolFile())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var projects []Project
	if err := json.Unmarshal(data, &projects); err != nil {
		return nil, err
	}
	return projects, nil
}

func save(projects []Project) error {
	data, err := json.MarshalIndent(projects, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(poolFile(), data, 0o644)
}

// reservedNames cannot be project names: a token {{worktree}} must mean the
// worktree, and {{port}} must stay a typo rather than a project.
var reservedNames = map[string]bool{
	dev.TokenWorktree: true, dev.TokenWorkspace: true,
	dev.AccessorURL: true, dev.AccessorHost: true, dev.AccessorPort: true,
}

// ValidateName is the rule a project name must pass to be usable as a binding
// token: the server-name charset, which has no "." or "/", and none of the
// reserved words. Existing pool entries are not re-checked.
func ValidateName(name string) error {
	if !validServerName.MatchString(name) {
		return fmt.Errorf("'%s' is not a valid project name — use a-z, 0-9 and -", name)
	}
	if reservedNames[name] {
		return fmt.Errorf("'%s' is reserved — it has a meaning inside {{…}} binding tokens", name)
	}
	return nil
}

// Add adds a project to the global pool.
func Add(proj Project) error {
	if err := ValidateName(proj.Name); err != nil {
		return err
	}
	projects, err := List()
	if err != nil {
		return err
	}
	for _, p := range projects {
		if p.Name == proj.Name {
			return fmt.Errorf("project '%s' already exists", proj.Name)
		}
	}
	projects = append(projects, proj)
	return save(projects)
}

// Remove removes a project by name from the global pool.
func Remove(name string) error {
	projects, err := List()
	if err != nil {
		return err
	}
	var filtered []Project
	for _, p := range projects {
		if p.Name != name {
			filtered = append(filtered, p)
		}
	}
	return save(filtered)
}

// Get returns a project by name.
func Get(name string) *Project {
	projects, _ := List()
	for _, p := range projects {
		if p.Name == name {
			return &p
		}
	}
	return nil
}

// Update saves changes to an existing project in the pool.
func Update(proj Project) error {
	projects, err := List()
	if err != nil {
		return err
	}
	for i, p := range projects {
		if p.Name == proj.Name {
			projects[i] = proj
			return save(projects)
		}
	}
	return fmt.Errorf("project '%s' not found", proj.Name)
}

// validateServerName: a server name becomes a tmux window, a log file and
// half of a {{project/server}} token, so it is kept to what all three can
// carry.
func validateServerName(name string) error {
	if !validServerName.MatchString(name) {
		return fmt.Errorf("server name '%s' is invalid — only lowercase letters, digits, and hyphens allowed", name)
	}
	return nil
}

// AddDevServer adds a dev server to a project in the pool.
func AddDevServer(projName string, ds DevServer) error {
	if err := validateServerName(ds.Name); err != nil {
		return err
	}
	projects, err := List()
	if err != nil {
		return err
	}
	for i, p := range projects {
		if p.Name == projName {
			// Replace existing with same name, or append
			for j, existing := range p.DevServers {
				if existing.Name == ds.Name {
					projects[i].DevServers[j] = ds
					return save(projects)
				}
			}
			projects[i].DevServers = append(projects[i].DevServers, ds)
			return save(projects)
		}
	}
	return fmt.Errorf("project '%s' not found", projName)
}

// RemoveDevServer removes a dev server by name from a project in the pool.
// The bindings scoped to it go in the same write — they have nowhere left
// to apply — and come back so the caller can say so.
func RemoveDevServer(projName, serverName string) (dropped []Binding, err error) {
	projects, err := List()
	if err != nil {
		return nil, err
	}
	for i, p := range projects {
		if p.Name == projName {
			var filtered []DevServer
			for _, ds := range p.DevServers {
				if ds.Name != serverName {
					filtered = append(filtered, ds)
				}
			}
			projects[i].DevServers = filtered
			dropped = scopedTo(p.Bindings, serverName)
			var kept []Binding
			for _, b := range p.Bindings {
				if b.Server != serverName {
					kept = append(kept, b)
				}
			}
			projects[i].Bindings = kept
			return dropped, save(projects)
		}
	}
	return nil, fmt.Errorf("project '%s' not found", projName)
}

// RenameDevServer is the editor's rename: the server under its new name,
// and the bindings scoped to it re-scoped in the same write, so a rename
// never turns them into "no dev server" rows.
func RenameDevServer(projName, oldName string, ds DevServer) error {
	if err := validateServerName(ds.Name); err != nil {
		return err
	}
	projects, err := List()
	if err != nil {
		return err
	}
	for i, p := range projects {
		if p.Name != projName {
			continue
		}
		var servers []DevServer
		for _, s := range p.DevServers {
			if s.Name != oldName && s.Name != ds.Name {
				servers = append(servers, s)
			}
		}
		projects[i].DevServers = append(servers, ds)
		for j, b := range p.Bindings {
			if b.Server == oldName {
				projects[i].Bindings[j].Server = ds.Name
			}
		}
		return save(projects)
	}
	return fmt.Errorf("project '%s' not found", projName)
}

// SetPath moves a project's canonical checkout. Worktrees already made from
// the old path keep working — git tracks them from the repo, not from crew.
func SetPath(projName, path string) error {
	if err := ValidateCheckoutDir(path); err != nil {
		return err
	}
	// The identity is read off the path later, from wherever crew runs.
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	projects, err := List()
	if err != nil {
		return err
	}
	for i, p := range projects {
		if p.Name == projName {
			projects[i].Path = path
			return save(projects)
		}
	}
	return fmt.Errorf("project '%s' not found", projName)
}

// SetSetup records or clears a project's explicit setup command.
func SetSetup(projName, command string) error {
	return update(projName, func(p *Project) { p.Setup = command })
}

// SetEnvCmd records or clears a project's env command.
func SetEnvCmd(projName, command string) error {
	return update(projName, func(p *Project) { p.EnvCmd = command })
}

func update(projName string, fn func(*Project)) error {
	projects, err := List()
	if err != nil {
		return err
	}
	for i, p := range projects {
		if p.Name == projName {
			fn(&projects[i])
			return save(projects)
		}
	}
	return fmt.Errorf("project '%s' not found", projName)
}

package project

import (
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
	"github.com/FurlanLuka/crew/crew/internal/exec"
)

var validServerName = regexp.MustCompile(`^[a-z0-9-]+$`)

// DevServer describes how to run a dev server for a project. Port is the
// port it conventionally listens on — reference only, crew allocates the
// real one — and 0 for a process that does not listen at all (a worker, a
// queue consumer): crew runs it, passes no PORT, hands out no URL, and a
// smoke only checks it stays alive.
type DevServer struct {
	Name    string `json:"name"`
	Port    int    `json:"port,omitempty"`
	Command string `json:"command"`
	Dir     string `json:"dir,omitempty"`
}

// Listens: the server has a port to be reached on.
func (ds DevServer) Listens() bool { return ds.Port > 0 }

// PortLabel is the port column wherever a server is listed: ":3000", or
// "no port".
func (ds DevServer) PortLabel() string {
	if !ds.Listens() {
		return "no port"
	}
	return fmt.Sprintf(":%d", ds.Port)
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

// NewTarget decides where a new project's checkout comes from: the clone
// crew will make into ClonePath(name), or — with a path — a checkout the
// user already has, taken absolute. It holds the refusals every caller
// needs in the same words: the name (valid, and not already in the pool —
// asked before any clone lands under it), the clone dir, the adopted
// directory. Pure but for the pool read and two stats.
func NewTarget(name, path string) (target string, clone bool, err error) {
	if err := ValidateName(name); err != nil {
		return "", false, err
	}
	if p := Get(name); p != nil {
		return "", false, fmt.Errorf("project '%s' already exists at %s — crew rm project %s first, or pick another name", name, p.Path, name)
	}
	if path != "" {
		if err := ValidateCheckoutDir(path); err != nil {
			return "", false, err
		}
		abs, err := filepath.Abs(path)
		if err != nil {
			return "", false, err
		}
		return abs, false, nil
	}
	if err := CloneAllowed(name); err != nil {
		return "", false, err
	}
	return ClonePath(name), true, nil
}

// RemoteOf is the project's identity: the origin its checkout points at,
// read when asked and never stored, so it cannot drift from the clone.
// "" for a repo without one — such a project cannot be cloned elsewhere.
func RemoteOf(p Project) string { return exec.OriginURL(p.Path) }

// NameFromURL is the project name a URL suggests: the last segment of the
// repo it names, with .git and a trailing slash already folded by RepoKey —
// one URL grammar, not a second one. crew add project <url> and the web's
// add form both name a clone this way. Pure; "" for "".
func NameFromURL(url string) string {
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
			dropped = ScopedTo(p.Bindings, serverName)
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

// RenameDevServer is the editor's rename: the server under its new name in
// its old place, the bindings scoped to it re-scoped, and every binding in
// the pool whose value names it ({{proj/old}}, .host, .port, the pre-2.1
// spelling) rewritten to the new name — all in the same write, so a rename
// never turns them into "no dev server" rows. The rewritten ones come back,
// named, never with their values.
func RenameDevServer(projName, oldName string, ds DevServer) ([]RetargetedBinding, error) {
	projects, err := List()
	if err != nil {
		return nil, err
	}
	renamed, rewritten, err := renameServerIn(projects, projName, oldName, ds)
	if err != nil {
		return nil, err
	}
	return rewritten, save(renamed)
}

// renameServerIn is the rename over the pool: it refuses an unknown old name
// and a new name another server of the project already has, so a rename
// never drops a server nor turns into an add. The input is left untouched.
// Pure.
func renameServerIn(projects []Project, projName, oldName string, ds DevServer) ([]Project, []RetargetedBinding, error) {
	if err := validateServerName(ds.Name); err != nil {
		return nil, nil, err
	}
	i := slices.IndexFunc(projects, func(p Project) bool { return p.Name == projName })
	if i < 0 {
		return nil, nil, fmt.Errorf("project '%s' not found", projName)
	}
	servers := slices.Clone(projects[i].DevServers)
	at := slices.IndexFunc(servers, func(s DevServer) bool { return s.Name == oldName })
	if at < 0 {
		return nil, nil, fmt.Errorf("project '%s' has no dev server '%s' (has: %s)", projName, oldName, serverNames(servers))
	}
	if ds.Name != oldName && slices.ContainsFunc(servers, func(s DevServer) bool { return s.Name == ds.Name }) {
		return nil, nil, fmt.Errorf("%s already has a server '%s' — crew dev rm %s %s first, or pick another name", projName, ds.Name, projName, ds.Name)
	}
	servers[at] = ds

	out := slices.Clone(projects)
	out[i].DevServers = servers
	var rewritten []RetargetedBinding
	for pi := range out {
		bindings := slices.Clone(out[pi].Bindings)
		for j, b := range bindings {
			if pi == i && b.Server == oldName {
				bindings[j].Server = ds.Name
			}
			if value, ok := retarget(b.Value, projName, oldName, ds.Name); ok {
				bindings[j].Value = value
				rewritten = append(rewritten, RetargetedBinding{Project: out[pi].Name, Var: b.Var, Server: bindings[j].Server})
			}
		}
		out[pi].Bindings = bindings
	}
	return out, rewritten, nil
}

// RetargetedBinding names a binding a server rename rewrote.
type RetargetedBinding struct {
	Project, Var, Server string
}

// Label is "<project> <VAR>", with " (<server>)" for a scoped one.
func (r RetargetedBinding) Label() string {
	if r.Server == "" {
		return r.Project + " " + r.Var
	}
	return r.Project + " " + r.Var + " (" + r.Server + ")"
}

// retarget rewrites every token in value that names proj/old to proj/new,
// in the spelling TokenFor writes. ok is false when none did — and for a
// value that does not parse, which is left for the validator to name.
// Pure.
func retarget(value, proj, old, renamed string) (string, bool) {
	tokens, err := dev.ParseTokens(value)
	if err != nil {
		return value, false
	}
	out, changed := value, false
	for _, tok := range tokens {
		t := tok.Target
		if tok.Kind != dev.TokenTarget || t.Project != proj || !t.HasServer || t.Server != old {
			continue
		}
		out = strings.ReplaceAll(out, tok.Raw, dev.TokenFor(dev.TargetRef{Project: proj, Server: renamed, HasServer: true}, tok.Accessor))
		changed = true
	}
	return out, changed
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

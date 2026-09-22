package addproject

// The concept block each card opens with: what the thing is, in the words
// the CLI cannot afford. Every block fits a 24-line terminal beside the
// card's own rows — five lines at most; the goldens pin the wording.

var conceptSource = []string{
	"A project is its git remote: that is what an export carries and what another",
	"machine clones. crew keeps its own clone under ~/.crew/projects/<name> and never",
	"works in it — every worktree and every check is a fresh checkout of it. The",
	"name is fixed once the clone lands.",
}

var conceptAdopt = []string{
	"A checkout you already have becomes the canonical instead of a clone: crew",
	"still never works in it — worktrees and checks are fresh checkouts of it. Its",
	"own origin is the project's identity; without one it cannot be exported for",
	"cloning on another machine.",
}

var conceptInstall = []string{
	"Every new checkout runs an install after mise: the lockfile picks the package",
	"manager, or a setup command replaces that (a Makefile target, a monorepo",
	"bootstrap, codegen). An env command then writes the checkout's env files — sops,",
	"a vault, make get-env — over the .env crew copied in. It must write files, not",
	"print values; its output is logged.",
}

var conceptServers = []string{
	"A dev server is a name, a port, a command, an optional dir. crew allocates a",
	"port per worktree, remembers it, and starts the command with PORT exported —",
	"the command must listen on $PORT (next dev -p $PORT, uvicorn --port $PORT). The",
	"port here is the one you would use by hand: reference only, so two worktrees",
	"never collide.",
}

var conceptBindings = []string{
	"A binding is VAR = template over {{proj[/server]}}, .host or .port, resolved",
	"per worktree from the ports crew allocated and injected as exports ahead of",
	"PORT — env files are read, never written; a worktree override wins. With two",
	"or more servers a binding can be scoped to one: a monorepo's web and its",
	"worker want different siblings.",
}

var conceptCheck = []string{
	"A check proves the project reproduces from nothing: a fresh checkout of the",
	"clone through mise, the install, the env command, then a smoke of each server",
	"alone (a sibling's URL resolves, nothing answers). ✓ removes the target; ✗",
	"keeps it with the evidence for f fix or c again.",
}

const (
	noTargetsLine  = "nothing to point at yet — bindings come with the second project that has servers"
	pointAtLine    = "to point an existing project at %s: crew add binding <other> --scan"
	envMissingLine = "no env files and no env command — a server that needs one will not come up: t sets one, i checks the install alone"
	noSmokeLine    = "no servers recorded — the check proves the install"
	notURLLine     = "not a git URL — ctrl+p adopts a checkout you already have"
	nameFixedLine  = "the name is fixed once the clone lands"
)

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	osexec "os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/voice"
)

const voiceDevUsage = "Usage: crew server dev push [--dry-run] | crew server dev status"

// crew server dev …: one build of crew and Voice OS from a checkout, on every
// machine. Any machine — the main or a remote — can push its own checkout.
func voiceDev(args []string) {
	sub := ""
	if len(args) > 0 {
		sub, args = args[0], args[1:]
	}
	switch sub {
	case "push":
		voiceDevPush(hasFlag(args, "--dry-run"))
	case "status":
		voiceDevStatus()
	case "_targets":
		// What a remote asks the main before it builds: every machine with its OS and CPU.
		voiceDevTargets()
	case "_handoff":
		// A remote's push handed to the main (voiceos/src/remote/link.ts adds --source).
		voiceDevHandoff(args)
	default:
		fmt.Fprintln(os.Stderr, voiceDevUsage)
		os.Exit(1)
	}
}

// checkoutRoot is the crew checkout the push builds: the git top level holding
// both crew/ and voiceos/.
func checkoutRoot() (string, error) {
	debug.Log("git", "git rev-parse --show-toplevel")
	out, err := osexec.Command("git", "rev-parse", "--show-toplevel").Output()
	if err != nil {
		return "", fmt.Errorf("not in a git checkout — run crew server dev push from a crew checkout")
	}
	root := strings.TrimSpace(string(out))
	for _, need := range []string{"crew/go.mod", "voiceos/package.json"} {
		if _, err := os.Stat(filepath.Join(root, need)); err != nil {
			return "", fmt.Errorf("%s is not a crew checkout (no %s)", root, need)
		}
	}
	return root, nil
}

// checkoutVersion is dev-<commit>, plus a hash of the uncommitted changes
// (tracked diff and untracked files) when there are any.
func checkoutVersion(root string) (string, error) {
	git := func(args ...string) ([]byte, error) {
		debug.Log("git", "git -C %s %s", root, strings.Join(args, " "))
		return osexec.Command("git", append([]string{"-C", root}, args...)...).Output()
	}
	sha, err := git("rev-parse", "--short", "HEAD")
	if err != nil {
		return "", err
	}
	diff, err := git("diff", "HEAD", "--binary")
	if err != nil {
		return "", err
	}
	untracked, err := git("ls-files", "--others", "--exclude-standard", "-z")
	if err != nil {
		return "", err
	}
	if len(diff) == 0 && len(untracked) == 0 {
		return voice.DevVersion(string(sha), ""), nil
	}
	h := sha256.New()
	h.Write(diff)
	for _, name := range strings.Split(strings.TrimRight(string(untracked), "\x00"), "\x00") {
		h.Write([]byte(name))
		if data, err := os.ReadFile(filepath.Join(root, name)); err == nil {
			h.Write(data)
		}
	}
	return voice.DevVersion(string(sha), hex.EncodeToString(h.Sum(nil))[:8]), nil
}

// pushRole: the main pushes itself, a remote hands off. A machine with a remote's
// state but no daemon running is refused: it would push as a main and turn into one.
func pushRole() (isRemote bool, err error) {
	switch voice.CurrentRole(false) {
	case voice.RoleRemote:
		return true, nil
	case voice.RoleMain:
		return false, nil
	}
	if _, err := os.Stat(voice.RemoteDir()); err == nil {
		return false, fmt.Errorf("this machine is a remote with its daemon down — start it first: crew server remote")
	}
	return false, nil
}

// remotePushRunning: a remote's push asks the main whether one already runs before
// it builds anything.
func remotePushRunning() error {
	reply, err := voice.AskMain(voice.RemoteQuerySocket(), []string{"voice", "dev", "status", "--json"})
	if err != nil || !reply.OK || reply.Value == nil || reply.Value.Code != 0 {
		return mainRefusal("did not say whether a push runs", reply, err)
	}
	return pushRunningFrom(reply.Value.Stdout)
}

// pushRunningFrom reads the main's dev status --json: null is no push yet, and
// one whose runner died is not running. Pure.
func pushRunningFrom(stdout string) error {
	var st *voice.DevPushStatus
	if json.Unmarshal([]byte(stdout), &st) == nil && st != nil && st.Running {
		return voice.ErrDevPushRunning
	}
	return nil
}

// mainRefusal names why the main did not do it; a main whose Voice OS predates
// dev push refuses the query, which needs saying plainly.
func mainRefusal(what string, reply voice.QueryReply, err error) error {
	why := describeReply(reply, err)
	if why == "not allowed" {
		return fmt.Errorf("the main %s: it runs a Voice OS without dev push — push once from the main first (crew server dev push there), then from anywhere", what)
	}
	return fmt.Errorf("the main %s: %s", what, why)
}

func voiceDevPush(dryRun bool) {
	fail := func(err error) {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	root, err := checkoutRoot()
	if err != nil {
		fail(err)
	}
	version, err := checkoutVersion(root)
	if err != nil {
		fail(err)
	}
	isRemote, err := pushRole()
	if err != nil {
		fail(err)
	}
	machines, err := pushTargets(isRemote)
	if err != nil {
		fail(err)
	}
	for _, m := range machines {
		target := m.Target.Dir()
		if m.Skipped != "" {
			target = "skipped: " + m.Skipped
		}
		fmt.Fprintf(human, "%s\t%s\n", m.Name, target)
	}
	fmt.Fprintln(human, "Copies to every machine first, then restarts them, this one last.")
	if dryRun {
		fmt.Fprintf(human, "Dry run: %s would be built for %d target(s) and pushed.\n", version, len(voice.DistinctTargets(machines)))
		return
	}
	running := voice.CheckDevPush
	if isRemote {
		running = remotePushRunning
	}
	if err := running(); err != nil {
		fail(err)
	}
	dir, err := voice.BuildDevPush(root, version, voice.DistinctTargets(machines), os.Stderr)
	if err != nil {
		fail(err)
	}
	if isRemote {
		reply, err := voice.AskMain(voice.RemoteQuerySocket(), []string{"voice", "dev", "_handoff", version})
		if err != nil || !reply.OK || reply.Value == nil || reply.Value.Code != 0 {
			fail(mainRefusal("did not take the push", reply, err))
		}
	} else {
		// The runner is this push's own crew for this machine: it knows _dev-push and stays put.
		runner := filepath.Join(dir, voice.Target{GOOS: runtime.GOOS, GOARCH: runtime.GOARCH}.Dir(), "crew")
		if err := voice.StartDevPush(version, voice.MainID, runner, voice.MainCrewPath()); err != nil {
			fail(err)
		}
	}
	fmt.Fprintf(human, "Pushing %s to every machine; nothing to wait for here. crew server dev status follows it.\n", version)
}

// pushTargets: the main reads its machines itself; a remote asks the main.
func pushTargets(isRemote bool) ([]voice.PushMachine, error) {
	if !isRemote {
		return voice.DevPushTargets()
	}
	reply, err := voice.AskMain(voice.RemoteQuerySocket(), []string{"voice", "dev", "_targets", "--json"})
	if err != nil || !reply.OK || reply.Value == nil || reply.Value.Code != 0 {
		return nil, mainRefusal("did not list its machines", reply, err)
	}
	var machines []voice.PushMachine
	if err := json.Unmarshal([]byte(reply.Value.Stdout), &machines); err != nil {
		return nil, err
	}
	return machines, nil
}

func describeReply(reply voice.QueryReply, err error) string {
	switch {
	case err != nil:
		return err.Error()
	case reply.Error != "":
		return reply.Error
	case reply.Value != nil:
		return strings.TrimSpace(reply.Value.Stderr)
	}
	return "no answer"
}

func voiceDevTargets() {
	machines, err := voice.DevPushTargets()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if jsonOutput {
		printJSON(machines)
		return
	}
	for _, m := range machines {
		fmt.Printf("%s\t%s\t%s\n", m.ID, m.Target.Dir(), m.Skipped)
	}
}

func voiceDevStatus() {
	if voice.CurrentRole(false) == voice.RoleRemote {
		reply, err := voice.AskMain(voice.RemoteQuerySocket(), []string{"voice", "dev", "status", "--json"})
		if err != nil || !reply.OK || reply.Value == nil || reply.Value.Code != 0 {
			fmt.Fprintf(os.Stderr, "Error: %v\n", mainRefusal("did not answer", reply, err))
			os.Exit(1)
		}
		if jsonOutput {
			os.Stdout.WriteString(reply.Value.Stdout)
			return
		}
		var st *voice.DevPushStatus
		if err := json.Unmarshal([]byte(reply.Value.Stdout), &st); err != nil {
			fmt.Print(reply.Value.Stdout)
			return
		}
		if st == nil {
			fmt.Println("No dev push yet.")
			return
		}
		fmt.Print(voice.RenderDevPush(*st))
		return
	}
	st, ok := voice.ReadDevPushLive()
	if jsonOutput {
		if !ok {
			printJSON(nil)
			return
		}
		printJSON(st)
		return
	}
	if !ok {
		fmt.Println("No dev push yet.")
		return
	}
	fmt.Print(voice.RenderDevPush(st))
}

// Mirrors query-allow.ts (DEV_VERSION); voiceos/test/fixtures/shared/dev-handoff.json pins both.
var (
	devVersionPattern = regexp.MustCompile(`^dev-[0-9a-f]{4,40}(-dirty-[0-9a-f]{8})?$`)
	sourcePattern     = regexp.MustCompile(`^--source=([a-z0-9-]{1,64})$`)
)

type handoff struct{ version, source string }

// parseHandoffArgs checks what a remote handed over: <version>, and the
// --source the main's link added. The build is always fetched from that
// remote's own push dir; a remote never names a path. Pure.
func parseHandoffArgs(args []string) (handoff, error) {
	if len(args) != 2 || !devVersionPattern.MatchString(args[0]) {
		return handoff{}, fmt.Errorf("usage: crew server dev _handoff <dev version> --source=<machine>")
	}
	match := sourcePattern.FindStringSubmatch(args[1])
	if match == nil || match[1] == voice.MainID {
		return handoff{}, fmt.Errorf("--source names the remote the build is on")
	}
	return handoff{version: args[0], source: match[1]}, nil
}

// voiceDevHandoff runs on the main for a remote's push.
func voiceDevHandoff(args []string) {
	h, err := parseHandoffArgs(args)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	debug.Log("voice", "dev push handed over: %s from %s", h.version, h.source)
	// This crew took the handoff, so it knows _dev-push: it runs the push.
	runner, err := exec.CrewBinary()
	if err == nil {
		err = voice.StartDevPush(h.version, h.source, runner, voice.MainCrewPath())
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Pushing %s from %s.\n", h.version, h.source)
}

// voiceDevRunner is the detached runner (crew server _dev-push <version> <source> <main's crew path>).
func voiceDevRunner(args []string) {
	if len(args) != 3 {
		os.Exit(2)
	}
	if err := voice.RunDevPush(args[0], args[1], args[2]); err != nil {
		os.Exit(1)
	}
}

package main

import (
	"encoding/json"
	"fmt"
	"os"
	osexec "os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/voice"
)

const voiceDevUsage = "Usage: crew voice dev push [--dry-run] | crew voice dev status"

// crew voice dev …: one build of crew and Voice OS from a checkout, on every
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
	case "targets":
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
	out, err := osexec.Command("git", "rev-parse", "--show-toplevel").Output()
	if err != nil {
		return "", fmt.Errorf("not in a git checkout — run crew voice dev push from a crew checkout")
	}
	root := strings.TrimSpace(string(out))
	for _, need := range []string{"crew/go.mod", "voiceos/package.json"} {
		if _, err := os.Stat(filepath.Join(root, need)); err != nil {
			return "", fmt.Errorf("%s is not a crew checkout (no %s)", root, need)
		}
	}
	return root, nil
}

func checkoutVersion(root string) (string, error) {
	sha, err := osexec.Command("git", "-C", root, "rev-parse", "--short", "HEAD").Output()
	if err != nil {
		return "", err
	}
	status, err := osexec.Command("git", "-C", root, "status", "--porcelain").Output()
	if err != nil {
		return "", err
	}
	return voice.DevVersion(string(sha), len(strings.TrimSpace(string(status))) > 0), nil
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
	isRemote := voice.CurrentRole(false) == voice.RoleRemote
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
	dir, err := voice.BuildDevPush(root, version, voice.DistinctTargets(machines), os.Stderr)
	if err != nil {
		fail(err)
	}
	if isRemote {
		reply, err := voice.AskMain(voice.RemoteQuerySocket(), []string{"voice", "dev", "_handoff", version, dir})
		if err != nil || !reply.OK || reply.Value == nil || reply.Value.Code != 0 {
			fail(fmt.Errorf("the main did not take the push: %s", describeReply(reply, err)))
		}
	} else if err := voice.StartDevPush(version, voice.MainID, dir); err != nil {
		fail(err)
	}
	fmt.Fprintf(human, "Pushing %s to every machine; nothing to wait for here. crew voice dev status follows it.\n", version)
}

// pushTargets: the main reads its machines itself; a remote asks the main.
func pushTargets(isRemote bool) ([]voice.PushMachine, error) {
	if !isRemote {
		return voice.DevPushTargets()
	}
	reply, err := voice.AskMain(voice.RemoteQuerySocket(), []string{"voice", "dev", "targets", "--json"})
	if err != nil || !reply.OK || reply.Value == nil || reply.Value.Code != 0 {
		return nil, fmt.Errorf("the main did not list its machines: %s", describeReply(reply, err))
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
		if err != nil || !reply.OK || reply.Value == nil {
			fmt.Fprintf(os.Stderr, "Error: the main did not answer: %s\n", describeReply(reply, err))
			os.Exit(1)
		}
		if jsonOutput {
			os.Stdout.WriteString(reply.Value.Stdout)
			return
		}
		var st voice.DevPushStatus
		if json.Unmarshal([]byte(reply.Value.Stdout), &st) != nil {
			fmt.Print(reply.Value.Stdout)
			return
		}
		fmt.Print(voice.RenderDevPush(st))
		return
	}
	st, ok := voice.ReadDevPush()
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

// Mirrors query-allow.ts (DEV_VERSION, BUILD_DIR); voiceos/test/fixtures/shared/dev-handoff.json pins both.
var (
	devVersionPattern = regexp.MustCompile(`^dev-[0-9a-f]{4,40}(-dirty)?$`)
	buildDirPattern   = regexp.MustCompile(`^/[\w./-]{1,400}$`)
	sourcePattern     = regexp.MustCompile(`^--source=([a-z0-9-]{1,64})$`)
)

type handoff struct{ version, dir, source string }

// parseHandoffArgs checks what a remote handed over: <version> <dir on the
// remote> and the --source the main's link added. The dir reaches scp on the
// remote's side, so it is held to plain path characters. Pure.
func parseHandoffArgs(args []string) (handoff, error) {
	if len(args) != 3 || !devVersionPattern.MatchString(args[0]) ||
		!buildDirPattern.MatchString(args[1]) || strings.Contains(args[1], "..") {
		return handoff{}, fmt.Errorf("usage: crew voice dev _handoff <dev version> <build dir> --source=<machine>")
	}
	match := sourcePattern.FindStringSubmatch(args[2])
	if match == nil || match[1] == voice.MainID {
		return handoff{}, fmt.Errorf("--source names the remote the build is on")
	}
	return handoff{version: args[0], dir: args[1], source: match[1]}, nil
}

// voiceDevHandoff runs on the main for a remote's push.
func voiceDevHandoff(args []string) {
	h, err := parseHandoffArgs(args)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	debug.Log("voice", "dev push handed over: %s from %s", h.version, h.source)
	if err := voice.StartDevPush(h.version, h.source, h.dir); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Pushing %s from %s.\n", h.version, h.source)
}

// voiceDevRunner is the detached runner (crew voice _dev-push <version> <source> <build dir>).
func voiceDevRunner(args []string) {
	if len(args) != 3 {
		os.Exit(2)
	}
	if err := voice.RunDevPush(args[0], args[1], args[2]); err != nil {
		os.Exit(1)
	}
}

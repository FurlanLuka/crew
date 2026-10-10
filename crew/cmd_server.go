package main

import (
	"errors"
	"fmt"
	"os"
	osexec "os/exec"
	"runtime"
	"strings"
	"syscall"

	"github.com/charmbracelet/x/term"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/voice"
)

// cmdServer is crew's server — Voice OS and the Set up page in one process:
// crew server [start|stop|restart|status|logs|debug-notes|notes|keys|remote|machines|discord|dev].
// Bare `crew server` is its status; bare `crew` is the start with the
// browser (cmdBare).
func cmdServer() { serverDispatch(os.Args[2:], "status") }

// cmdVoiceAlias keeps `crew voice …` working forever: Voice OS itself calls
// crew back that way (voice machines, voice _attach, voice logs --local …)
// and an older main drives a newer remote with it. Bare `crew voice` still
// starts it, as it always did. The note is for a person only — a machine
// caller reads stderr too.
func cmdVoiceAlias() {
	if showAliasNote(term.IsTerminal(os.Stderr.Fd()), os.Args[2:]) {
		fmt.Fprintln(os.Stderr, aliasNote)
	}
	serverDispatch(os.Args[2:], "start")
}

// showAliasNote: a person at a terminal hears about the new name once per
// command; a program (no tty, or a hidden form another process runs) never
// does. Pure.
func showAliasNote(stderrTTY bool, args []string) bool {
	return stderrTTY && !strings.HasPrefix(firstArg(args), "_")
}

const aliasNote = "note: crew voice is crew server now (crew voice keeps working); bare crew starts it and opens the page"

func firstArg(args []string) string {
	if len(args) == 0 {
		return ""
	}
	return args[0]
}

// serverSub splits the words after crew server (or crew voice): the
// subcommand, else the bare default when only flags (or nothing) follow.
// Pure.
func serverSub(args []string, bare string) (string, []string) {
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		return args[0], args[1:]
	}
	return bare, args
}

func serverDispatch(args []string, bare string) {
	sub, args := serverSub(args, bare)

	switch sub {
	case "start":
		voiceStart(!hasFlag(args, "--no-open"))
	case "restart":
		voiceRestart(!hasFlag(args, "--no-open"))
	case "_restart":
		// The detached half of restart (restartCommand): nothing waits on its output.
		voice.Stop()
		if _, err := voice.Start(); err != nil {
			debug.Log("voice", "restart: %v", err)
			os.Exit(1)
		}
	case "stop":
		voice.Stop()
		if jsonOutput {
			printJSON(map[string]bool{"stopped": true})
			return
		}
		fmt.Println("Stopped crew's server and the Claude sessions it was running. Their conversations resume on the next start.")
	case "status":
		voicePrint(voice.Inspect())
	case "logs", "debug-notes", "notes":
		voiceQuery(append([]string{sub}, args...))
	case "link":
		voiceLink(args)
	case "keys":
		voiceKeys(args)
	case "remote":
		voiceRemote(args)
	case "_attach":
		// The end of a main's SSH login (voiceos/src/remote/ssh.ts): stdout is the link.
		voiceAttach()
	case "machines":
		voiceMachines(args)
	case "discord":
		voiceDiscord(args)
	case "dev":
		voiceDev(args)
	case "_dev-push":
		// The detached dev push runner (voice.StartDevPush): nothing waits on its output.
		voiceDevRunner(args)
	default:
		fmt.Fprintf(os.Stderr, "Usage: crew server [start|stop|restart|status|logs|debug-notes|notes|keys|remote|machines|discord|dev] [--no-open]\n")
		os.Exit(1)
	}
}

// cmdBare is crew with no command: its server started when needed and the
// page opened — Set up and Voice OS both live there. It never blocks: no
// key prompt (keys are set on the page), and claude is not required here
// (the page says when a session cannot start without it). Only tmux is.
func cmdBare(args []string) {
	for _, a := range args {
		if a != "--no-open" {
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\nUsage: crew [--no-open]\n", a)
			os.Exit(1)
		}
	}
	if voice.RemoteRunning() {
		fmt.Println(remoteMachineLine)
		return
	}
	if !voice.Inspect().Healthy {
		requireBareDeps()
		installVoiceOr(cliFallbackLine)
	}
	st, err := voice.Start()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n%s\n", err, cliFallbackLine)
		os.Exit(1)
	}
	if jsonOutput {
		printJSON(st)
		return
	}
	if st.Warning != "" {
		fmt.Fprintf(os.Stderr, "! %s\n", st.Warning)
	}
	ssh := underSSH()
	for _, line := range serverLinkLines(st, ssh, ssh && voice.ProxyRouteAnswers(), config.LoadSettings().SSHHost) {
		fmt.Println(line)
	}
	openVoiceLink(st, !hasFlag(args, "--no-open"))
}

// remoteMachineLine: a remote runs no page of its own; the main's crew is
// where this machine is set up.
const remoteMachineLine = "This machine is a remote — another machine's crew drives it (crew server remote status). Open crew there."

// cliFallbackLine: the page is one way in; every action on it is a command.
const cliFallbackLine = "Everything the page does is a command too: crew add project, crew ls projects|workspaces|worktrees, crew help."

// requireBareDeps is requireVoiceDeps for bare crew: tmux alone stops it.
func requireBareDeps() {
	failUnmet("crew's server needs:", bareRequirements(voice.UnmetRequirements()), cliFallbackLine)
}

// bareRequirements keeps what bare crew cannot start without. A missing
// claude only stops a session, and the page names it there. Pure.
func bareRequirements(unmet []voice.Requirement) []voice.Requirement {
	var out []voice.Requirement
	for _, r := range unmet {
		if r.Name == "tmux" {
			out = append(out, r)
		}
	}
	return out
}

func underSSH() bool { return os.Getenv("SSH_CONNECTION") != "" || os.Getenv("SSH_TTY") != "" }

// serverLinkLines is where bare crew says to open the page. Over SSH the
// localhost link is the remote's own localhost: the proxy's link whenever
// the proxy reaches the server under a name other devices resolve (a domain
// set, or the automatic server_ip nip.io one), else the tunnel that makes
// localhost reach it. Pure.
func serverLinkLines(st voice.Status, ssh, proxyReaches bool, sshHost string) []string {
	if !ssh {
		return []string{"crew is running: " + st.LocalhostURL}
	}
	if proxyReaches && st.URL != "" {
		return []string{"crew is running: " + st.URL}
	}
	if sshHost == "" {
		sshHost = "<this machine>"
	}
	return []string{
		fmt.Sprintf("crew is running on this machine, port %d. From your computer:", st.Port),
		fmt.Sprintf("  ssh -L %d:localhost:%d %s", st.Port, st.Port, sshHost),
		"then open " + st.LocalhostURL,
	}
}

func hasFlag(args []string, flag string) bool {
	for _, a := range args {
		if a == flag {
			return true
		}
	}
	return false
}

func voiceStart(open bool) {
	refuseIfRemote()
	// A Voice OS already answering only needs its links again: nothing to check,
	// even from a shell whose PATH lacks claude.
	if !voice.Inspect().Healthy {
		requireVoiceDeps()
		installVoiceIfMissing()
		askMissingKeys()
	}
	st, err := voice.Start()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	voicePrint(st)
	openVoiceLink(st, open)
}

// voiceRestart runs the stop and the start in a crew of its own: a Claude
// session Voice OS runs dies when Voice OS stops, so a restart asked for from
// one (the usual case) would die before it started Voice OS again. The helper
// is detached (its own session), outlives this process, and is waited for when
// this one survives.
func voiceRestart(open bool) {
	refuseIfRemote()
	requireVoiceDeps()
	installVoiceIfMissing()
	askMissingKeys()
	bin, err := exec.CrewBinary()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	cmd := restartCommand(bin)
	debug.Log("voice", "%s voice _restart (detached)", bin)
	if err := cmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: Voice OS did not restart (%v) — crew debug --tail=20 says why\n", err)
		os.Exit(1)
	}
	st := voice.Inspect()
	voicePrint(st)
	openVoiceLink(st, open)
}

func restartCommand(bin string) *osexec.Cmd {
	cmd := osexec.Command(bin, "voice", "_restart")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return cmd
}

func openVoiceLink(st voice.Status, open bool) {
	env := openEnv{
		Requested: open,
		JSON:      jsonOutput,
		StdoutTTY: term.IsTerminal(os.Stdout.Fd()),
		GOOS:      runtime.GOOS,
		SSH:       underSSH(),
		Display:   os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != "",
	}
	if !shouldOpenBrowser(env) || st.LocalhostURL == "" {
		return
	}
	opener := browserOpener(runtime.GOOS)
	debug.Log("voice", "%s %s", opener, st.LocalhostURL)
	// The link is already printed; a machine without an opener loses nothing
	// but the convenience.
	if err := osexec.Command(opener, st.LocalhostURL).Start(); err != nil {
		debug.Log("voice", "%s failed: %v", opener, err)
	}
}

// openEnv is what decides whether a browser opens.
type openEnv struct {
	Requested bool // no --no-open
	JSON      bool
	StdoutTTY bool
	GOOS      string
	SSH       bool // a browser here is on the wrong machine
	Display   bool // X11 or Wayland: Linux has somewhere to open it
}

// shouldOpenBrowser: only for a person at this machine's screen — never for
// a script, a --json reader, an SSH login, or a Linux box with no display.
// Pure.
func shouldOpenBrowser(e openEnv) bool {
	if !e.Requested || e.JSON || !e.StdoutTTY || e.SSH {
		return false
	}
	return e.GOOS == "darwin" || e.Display
}

func browserOpener(goos string) string {
	if goos == "darwin" {
		return "open"
	}
	return "xdg-open"
}

func voicePrint(st voice.Status) {
	if jsonOutput {
		printJSON(st)
		return
	}
	state := "down"
	switch {
	case st.Healthy:
		state = "up"
	case st.Running:
		state = "up (not answering)"
	}
	fmt.Printf("%s\t%d\t%s\t%s\n", state, st.Port, st.LocalhostURL, st.URL)
	if st.Warning != "" {
		fmt.Fprintf(os.Stderr, "! %s\n", st.Warning)
	}
	switch {
	case st.Healthy && st.Secure:
		fmt.Fprintf(human, "Open %s — the microphone works there on any device that trusts crew's CA (crew dev proxy trust); %s works on this Mac.\n", st.URL, st.LocalhostURL)
	case st.Healthy:
		fmt.Fprintf(human, "Open %s — the localhost link is the one with microphone access; the proxy link is text only until HTTPS is up (crew dev proxy status).\n", st.LocalhostURL)
	}
}

// installVoiceIfMissing is the first run: the Voice OS of this crew's own
// release, so the two always match. A dev crew has no release to take it from.
func installVoiceIfMissing() { installVoiceOr("") }

// installVoiceOr is installVoiceIfMissing with a last line for a failure —
// bare crew names the commands that work without the page.
func installVoiceOr(hint string) {
	downloaded, err := voice.EnsureInstalled(Version, func() {
		fmt.Fprintf(human, "Downloading Voice OS v%s for %s/%s (25–40 MB)…\n", Version, runtime.GOOS, runtime.GOARCH)
	})
	switch {
	case errors.Is(err, voice.ErrDevBuild):
		fmt.Fprintf(os.Stderr, "Error: Voice OS is not installed at %s, and %v — build it with: cd voiceos && bun run install-dev\n", voice.Binary(), err)
		printHint(hint)
		os.Exit(1)
	case err != nil:
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		printHint(hint)
		os.Exit(1)
	case downloaded:
		fmt.Fprintf(human, "Installed Voice OS at %s.\n", voice.Binary())
	}
}

func printHint(hint string) {
	if hint != "" {
		fmt.Fprintln(os.Stderr, hint)
	}
}

// refreshVoice keeps an installed Voice OS on the crew version now in place,
// whether crew just updated or already was current. It never restarts a
// running one: that would end every Claude session in it.
func refreshVoice(version string) {
	updated, err := voice.Refresh(version)
	if err != nil {
		fmt.Fprintf(os.Stderr, "! Voice OS was not updated: %v\n", err)
		return
	}
	if !updated {
		return
	}
	if voice.Inspect().Running {
		fmt.Fprintf(human, "Voice OS updated to v%s — crew server restart to use it.\n", version)
		return
	}
	fmt.Fprintf(human, "Voice OS updated to v%s.\n", version)
}

// requireVoiceDeps stops before any download or key prompt when Voice OS could
// not run anyway, naming each missing piece with its fix.
func requireVoiceDeps() {
	failUnmet("Voice OS needs a few things first:", voice.UnmetRequirements(), "")
}

// failUnmet exits naming each missing requirement with its fix — {missing}
// under --json — and returns when nothing is missing. hint, when set, is the
// last line.
func failUnmet(header string, unmet []voice.Requirement, hint string) {
	if len(unmet) == 0 {
		return
	}
	if jsonOutput {
		printJSON(map[string]any{"missing": unmet})
		os.Exit(1)
	}
	fmt.Fprintln(os.Stderr, header)
	for _, req := range unmet {
		fmt.Fprintf(os.Stderr, "  %s — %s. Install: %s\n", req.Name, req.Why, req.Install)
	}
	printHint(hint)
	os.Exit(1)
}

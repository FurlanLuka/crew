package main

import (
	"fmt"
	"os"
	"strings"
	"syscall"

	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/voice"
)

// Exit codes of crew voice _attach, read by the main that ran it over SSH
// (voiceos/src/remote/link-state.ts classifyExit reads the stderr line).
const (
	attachRequirements = 3
	attachCockpit      = 4
	attachNoDaemon     = 5
	attachInstall      = 6
)

// A machine is a main or a remote: two drivers on one worktree's Claude would fight.
func refuseIfRemote() {
	if voice.RemoteRunning() {
		fmt.Fprintln(os.Stderr, "Error: this machine runs Voice OS as a remote (another machine drives it) — crew voice remote stop first")
		os.Exit(1)
	}
}

// voiceRemote: crew voice remote [status|stop]. Bare, it checks this machine
// can be a remote, installs Voice OS if needed, starts the daemon and says so.
func voiceRemote(args []string) {
	sub := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		sub = args[0]
	}
	switch sub {
	case "":
		requireVoiceDeps()
		if voice.CockpitRunning() {
			fmt.Fprintln(os.Stderr, "Error: Voice OS runs here as the main — a machine is either a main or a remote (crew voice stop first)")
			os.Exit(1)
		}
		installVoiceIfMissing()
		action, err := voice.EnsureRemote()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		if action == voice.DaemonRestart {
			fmt.Fprintln(human, "Restarted the daemon on the installed Voice OS; its sessions resume on the next message.")
		}
		printRemote(voice.InspectRemote())
		fmt.Fprintf(human, "Ready: add this machine on the main (crew voice machines add <ssh host>, or + Add machine on the page).\n")
	case "status":
		printRemote(voice.InspectRemote())
	case "stop":
		voice.StopRemote()
		if jsonOutput {
			printJSON(map[string]bool{"stopped": true})
			return
		}
		fmt.Println("Stopped the remote daemon and the Claude sessions it was running.")
	default:
		fmt.Fprintln(os.Stderr, "Usage: crew voice remote [status|stop]")
		os.Exit(1)
	}
}

func printRemote(st voice.RemoteStatus) {
	if jsonOutput {
		printJSON(st)
		return
	}
	state, work := "down", "idle"
	if st.Running {
		state = "up"
	}
	if st.Busy {
		work = "busy"
	}
	fmt.Printf("%s\t%s\t%s\t%s\n", state, orDash(st.Version), work, st.Socket)
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// voiceAttach is run by a main over SSH: everything for a human goes to
// stderr, since stdout becomes the link once the daemon is up.
func voiceAttach() {
	human = os.Stderr
	if line, code := attachRefusal(voice.UnmetRequirements(), voice.CockpitRunning()); code != 0 {
		fmt.Fprintln(os.Stderr, line)
		os.Exit(code)
	}
	// Not installVoiceIfMissing: its failure line is for a person, and this one is read by the main.
	if _, err := voice.EnsureInstalled(Version, func() {
		fmt.Fprintf(os.Stderr, "Downloading Voice OS v%s…\n", Version)
	}); err != nil {
		fmt.Fprintf(os.Stderr, "crew-remote-error: install: %v\n", err)
		os.Exit(attachInstall)
	}
	if _, err := voice.EnsureRemote(); err != nil {
		debug.Log("voice", "attach: %v", err)
		fmt.Fprintf(os.Stderr, "crew-remote-error: daemon-not-listening: %v\n", err)
		os.Exit(attachNoDaemon)
	}
	argv := attachArgv(voice.Binary())
	debug.Log("voice", "attach → %s", strings.Join(argv, " "))
	if err := syscall.Exec(argv[0], argv, os.Environ()); err != nil {
		fmt.Fprintf(os.Stderr, "crew-remote-error: daemon-not-listening: %v\n", err)
		os.Exit(attachNoDaemon)
	}
}

func attachArgv(binary string) []string { return []string{binary, "remote", "attach"} }

// attachRefusal is why this machine cannot be a remote right now, as the line
// and exit code the main reads (0: it can). Pure.
func attachRefusal(unmet []voice.Requirement, isCockpit bool) (string, int) {
	if len(unmet) > 0 {
		names := make([]string, 0, len(unmet))
		for _, r := range unmet {
			names = append(names, r.Name)
		}
		return "crew-remote-error: requirements: " + strings.Join(names, ", "), attachRequirements
	}
	if isCockpit {
		return "crew-remote-error: cockpit-running", attachCockpit
	}
	return "", 0
}

// voiceMachines: crew voice machines [ls] | add <host> [--name=<name>] | rm <id> | rename <id> <name>.
func voiceMachines(args []string) {
	sub := "ls"
	if len(args) > 0 {
		sub, args = args[0], args[1:]
	}
	switch sub {
	case "ls":
		rows, err := voice.MachineRows()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		if jsonOutput {
			printJSON(rows)
			return
		}
		for _, row := range rows {
			fmt.Println(formatMachineRow(row))
		}
		if len(rows) == 0 {
			fmt.Fprintln(human, "No other machines yet: crew voice machines add <ssh host>.")
		}
	case "add":
		host, name := "", ""
		for _, a := range args {
			if v, ok := strings.CutPrefix(a, "--name="); ok {
				name = v
			} else if host == "" {
				host = a
			}
		}
		if host == "" {
			fmt.Fprintln(os.Stderr, "Usage: crew voice machines add <ssh host> [--name=<name>]")
			os.Exit(1)
		}
		m, err := voice.AddMachine(host, name)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		if jsonOutput {
			printJSON(m)
			return
		}
		fmt.Println(m.ID)
		fmt.Fprintf(human, "Added %s (%s). It needs crew there: run crew voice remote on it once.\n", m.Name, m.Host)
	case "rm":
		if len(args) != 1 {
			fmt.Fprintln(os.Stderr, "Usage: crew voice machines rm <id>")
			os.Exit(1)
		}
		if err := voice.RemoveMachine(args[0]); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		if jsonOutput {
			printJSON(map[string]string{"removed": args[0]})
			return
		}
		fmt.Printf("Removed %s. Its sessions keep running there; this Voice OS no longer drives them.\n", args[0])
	case "rename":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "Usage: crew voice machines rename <id> <name>")
			os.Exit(1)
		}
		name := strings.Join(args[1:], " ")
		if err := voice.RenameMachine(args[0], name); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		if jsonOutput {
			printJSON(map[string]string{"renamed": args[0], "name": name})
			return
		}
		fmt.Printf("Renamed %s to %s.\n", args[0], name)
	default:
		fmt.Fprintln(os.Stderr, "Usage: crew voice machines [ls] | add <ssh host> [--name=<name>] | rm <id> | rename <id> <name>")
		os.Exit(1)
	}
}

// formatMachineRow is one tab-separated ls line: id, name, host, status. Pure.
func formatMachineRow(row voice.MachineRow) string {
	return strings.Join([]string{row.ID, row.Name, row.Host, row.Status}, "\t")
}

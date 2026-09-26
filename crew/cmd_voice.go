package main

import (
	"fmt"
	"os"
	osexec "os/exec"
	"strings"

	"github.com/charmbracelet/x/term"

	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/voice"
)

// cmdVoice runs Voice OS: crew voice [start|stop|restart|status|logs].
// Bare `crew voice` starts it when needed and always reprints the sign-in
// link, so a lost cookie is one command away.
func cmdVoice() {
	sub := "start"
	args := os.Args[2:]
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		sub = args[0]
		args = args[1:]
	}

	switch sub {
	case "start":
		voiceStart(!hasFlag(args, "--no-open"))
	case "restart":
		voice.Stop()
		voiceStart(!hasFlag(args, "--no-open"))
	case "stop":
		voice.Stop()
		if jsonOutput {
			printJSON(map[string]bool{"stopped": true})
			return
		}
		fmt.Println("Stopped Voice OS and the Claude sessions it was running. Their conversations resume on the next start.")
	case "status":
		voicePrint(voice.Inspect())
	case "logs":
		voiceLogs(args)
	default:
		fmt.Fprintf(os.Stderr, "Usage: crew voice [start|stop|restart|status|logs] [--no-open] [--lines=<n>]\n")
		os.Exit(1)
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
	st, err := voice.Start()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	voicePrint(st)
	if open && !jsonOutput && term.IsTerminal(os.Stdout.Fd()) && st.LocalhostURL != "" {
		debug.Log("voice", "open %s", st.LocalhostURL)
		if err := osexec.Command("open", st.LocalhostURL).Start(); err != nil {
			debug.Log("voice", "open failed: %v", err)
		}
	}
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

func voiceLogs(args []string) {
	lines := "80"
	for _, a := range args {
		if strings.HasPrefix(a, "--lines=") {
			lines = strings.TrimPrefix(a, "--lines=")
		}
	}
	debug.Log("voice", "tail -n %s %s", lines, voice.LogFile())
	cmd := osexec.Command("tail", "-n", lines, voice.LogFile())
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "No Voice OS log yet at %s\n", voice.LogFile())
		os.Exit(1)
	}
}

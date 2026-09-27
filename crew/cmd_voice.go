package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	osexec "os/exec"
	"strings"

	"github.com/charmbracelet/x/term"

	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/voice"
)

// cmdVoice runs Voice OS: crew voice [start|stop|restart|status|logs|keys].
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
	case "keys":
		voiceKeys(args)
	default:
		fmt.Fprintf(os.Stderr, "Usage: crew voice [start|stop|restart|status|logs|keys] [--no-open] [--lines=<n>]\n")
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
	askMissingKeys()
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

// maxKeyTries: a rejected key is asked again, a few times, then left to crew voice keys set.
const maxKeyTries = 3

// askMissingKeys is the first run: at a terminal, each missing key is asked
// for and checked before Voice OS starts. Anywhere else it only says what is
// missing — nothing needs a tty.
func askMissingKeys() {
	missing := voice.MissingKeys()
	if len(missing) == 0 {
		return
	}
	if jsonOutput || !term.IsTerminal(os.Stdin.Fd()) {
		fmt.Fprintf(os.Stderr, "! Voice OS has no %s key yet: voice stays off until one is set (crew voice keys set <%s>)\n",
			strings.Join(missing, " or "), strings.Join(voice.KeyNames, "|"))
		return
	}
	fmt.Println("Voice OS needs two API keys to hear and speak. They are stored on this machine only, readable by you alone.")
	for _, name := range missing {
		for try := 1; try <= maxKeyTries; try++ {
			fmt.Printf("%s key (%s, hidden as you paste): ", keyLabel(name), keyUseOf(name))
			raw, err := term.ReadPassword(os.Stdin.Fd())
			fmt.Println()
			if err != nil || strings.TrimSpace(string(raw)) == "" {
				fmt.Printf("Skipped: set it later with crew voice keys set %s\n", name)
				break
			}
			if saveCheckedKey(name, string(raw)) {
				break
			}
			if try == maxKeyTries {
				fmt.Printf("Not saved: set it later with crew voice keys set %s\n", name)
			}
		}
	}
}

// saveCheckedKey keeps a key the service accepts, or one it could not be asked
// about (offline); a rejected one is not written.
func saveCheckedKey(name, value string) bool {
	value = strings.TrimSpace(value)
	err := voice.CheckKey(name, value)
	if errors.Is(err, voice.ErrKeyRejected) {
		fmt.Fprintf(os.Stderr, "%s rejected that key — check it and try again.\n", keyLabel(name))
		return false
	}
	if saveErr := voice.SaveKey(name, value); saveErr != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", saveErr)
		return false
	}
	if err != nil {
		fmt.Fprintf(human, "Saved the %s key, but %v — it is checked again when Voice OS uses it.\n", name, err)
		return true
	}
	fmt.Fprintf(human, "Saved the %s key (%s).\n", name, voice.KeyPath(name))
	return true
}

func keyLabel(name string) string {
	if name == "anthropic" {
		return "Anthropic"
	}
	return "Soniox"
}

func keyUseOf(name string) string {
	for _, st := range voice.InspectKeys() {
		if st.Name == name {
			return st.Use
		}
	}
	return ""
}

// voiceKeys: crew voice keys [status] | crew voice keys set <anthropic|soniox>.
// set reads the key from stdin (hidden at a terminal), so it never lands in
// shell history or a process list.
func voiceKeys(args []string) {
	if len(args) == 0 || args[0] == "status" {
		statuses := voice.InspectKeys()
		if jsonOutput {
			printJSON(statuses)
			return
		}
		for _, st := range statuses {
			state := "missing"
			if st.Set {
				state = "set (" + st.Source + ")"
			}
			fmt.Printf("%s\t%s\t%s\n", st.Name, state, st.Path)
		}
		return
	}
	if args[0] != "set" || len(args) < 2 || !voice.IsKeyName(args[1]) {
		fmt.Fprintf(os.Stderr, "Usage: crew voice keys [status] | crew voice keys set <%s>\n", strings.Join(voice.KeyNames, "|"))
		os.Exit(1)
	}
	name := args[1]
	value, err := readSecret(fmt.Sprintf("%s key (hidden as you paste): ", keyLabel(name)))
	if err != nil || strings.TrimSpace(value) == "" {
		fmt.Fprintln(os.Stderr, "Error: no key given (paste it, or pipe it on stdin)")
		os.Exit(1)
	}
	if !saveCheckedKey(name, value) {
		os.Exit(1)
	}
	if jsonOutput {
		printJSON(map[string]string{"saved": name, "path": voice.KeyPath(name)})
	}
	if voice.Inspect().Running {
		fmt.Fprintln(human, "Voice OS is running: crew voice restart picks the key up.")
	}
}

func readSecret(prompt string) (string, error) {
	if term.IsTerminal(os.Stdin.Fd()) {
		fmt.Fprint(os.Stderr, prompt)
		raw, err := term.ReadPassword(os.Stdin.Fd())
		fmt.Fprintln(os.Stderr)
		return string(raw), err
	}
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if errors.Is(err, io.EOF) {
		err = nil
	}
	return line, err
}

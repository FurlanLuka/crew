package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/charmbracelet/x/term"

	"github.com/FurlanLuka/crew/crew/internal/voice"
)

// maxKeyTries: a rejected key is asked again, a few times, then left to crew server keys set.
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
		fmt.Fprintf(os.Stderr, "! Voice OS has no %s key yet: voice stays off until one is set (crew server keys set <%s>)\n",
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
				fmt.Printf("Skipped: set it later with crew server keys set %s\n", name)
				break
			}
			if saveCheckedKey(name, string(raw)) {
				break
			}
			if try == maxKeyTries {
				fmt.Printf("Not saved: set it later with crew server keys set %s\n", name)
			}
		}
	}
}

// saveCheckedKey keeps a key the service accepts, or one it could not be asked
// about (offline); a rejected one is not written.
func saveCheckedKey(name, value string) bool {
	verified, err := voice.SaveChecked(name, value)
	switch {
	case errors.Is(err, voice.ErrKeyRejected):
		fmt.Fprintln(os.Stderr, keyRejectedLine(name))
		return false
	case err != nil:
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		return false
	case !verified:
		fmt.Fprintf(human, "Saved the %s key, but it could not be checked (offline?) — Voice OS tells you if it is refused.\n", name)
		return true
	}
	fmt.Fprintf(human, "Saved the %s key (%s).\n", name, voice.KeyPath(name))
	return true
}

// keyRejectedLine is what a key the service refused is answered with — on
// the terminal and, through crew server keys set, on the page. Pure.
func keyRejectedLine(name string) string {
	return keyLabel(name) + " rejected that key — check it and try again."
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

// voiceKeys: crew server keys [status] | crew server keys set <anthropic|soniox>.
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
		fmt.Fprintf(os.Stderr, "Usage: crew server keys [status] | crew server keys set <%s>\n", strings.Join(voice.KeyNames, "|"))
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
		printJSON(keySavedDoc(name, voice.KeyPath(name)))
	}
	if voice.Inspect().Running {
		fmt.Fprintln(human, "Voice OS picks the key up from your next words.")
	}
}

// keySavedDoc is crew server keys set --json. Pure.
func keySavedDoc(name, path string) map[string]string {
	return map[string]string{"saved": name, "path": path}
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

package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/voice"
)

const (
	phonesUsage    = "Usage: crew server phones [ls] | add [--name=<name>] | rm <id>"
	tailscaleUsage = "Usage: crew server tailscale [status] | serve | off"
)

// voicePhones: crew server phones [ls] | add | rm.
func voicePhones(args []string) {
	sub := "ls"
	if len(args) > 0 {
		sub, args = args[0], args[1:]
	}
	switch sub {
	case "ls":
		phonesLs()
	case "add":
		phonesAdd(args)
	case "rm":
		phonesRm(args)
	default:
		fmt.Fprintln(os.Stderr, phonesUsage)
		os.Exit(1)
	}
}

func phonesLs() {
	rows, err := voice.PhoneRows()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if jsonOutput {
		printJSON(rows)
		return
	}
	for _, row := range rows {
		fmt.Println(voice.FormatPhoneRow(row))
	}
	if len(rows) == 0 {
		fmt.Fprintln(human, "No phones yet: crew server phones add.")
	}
}

func phonesAdd(args []string) {
	name := ""
	for _, a := range args {
		v, ok := strings.CutPrefix(a, "--name=")
		if !ok {
			fmt.Fprintf(os.Stderr, "Error: unknown argument %q\n%s\n", a, phonesUsage)
			os.Exit(1)
		}
		name = v
	}
	added, err := voice.AddPhone(name)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if jsonOutput {
		printJSON(added)
		return
	}
	fmt.Println(added.Link)
	fmt.Fprintf(human, "%s (%s) %s\n", added.Name, added.ID, voice.PhoneViaLine(added.Via))
}

func phonesRm(args []string) {
	if len(args) != 1 {
		fmt.Fprintln(os.Stderr, "Usage: crew server phones rm <id>")
		os.Exit(1)
	}
	if err := voice.RemovePhone(args[0]); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if jsonOutput {
		printJSON(map[string]string{"removed": args[0]})
		return
	}
	fmt.Printf("Removed %s. Its link no longer opens Voice OS.\n", args[0])
}

// voiceTailscale: crew server tailscale [status] | serve | off.
func voiceTailscale(args []string) {
	sub := "status"
	if len(args) > 0 {
		sub = args[0]
	}
	switch sub {
	case "status":
		st := voice.InspectTailscale()
		if jsonOutput {
			printJSON(st)
			return
		}
		for _, row := range tailscaleRows(st) {
			fmt.Printf("%s\t%s\n", row[0], row[1])
		}
	case "serve":
		serve, err := voice.ServeTailscale()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		if jsonOutput {
			printJSON(serve)
			return
		}
		fmt.Println(serve.URL)
		fmt.Fprintln(human, "Voice OS is on your tailnet over HTTPS; crew server phones add makes a link that opens it there.")
	case "off":
		removed, err := voice.TailscaleOff()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		if jsonOutput {
			printJSON(map[string][]string{"removed": removed})
			return
		}
		if len(removed) == 0 {
			fmt.Println("Voice OS was not served on Tailscale: nothing to stop.")
			return
		}
		for _, path := range removed {
			fmt.Printf("removed\t%s\n", path)
		}
		fmt.Fprintln(human, "Voice OS is off your tailnet; phone links made for it stop working until crew server tailscale serve.")
	default:
		fmt.Fprintln(os.Stderr, tailscaleUsage)
		os.Exit(1)
	}
}

// tailscaleRows is the status table, <check>\t<value> per row. Pure.
func tailscaleRows(st voice.TailscaleStatus) [][2]string {
	signedIn := yesNo(st.SignedIn)
	if st.SignedIn && st.User != "" {
		signedIn += " (" + st.User + ")"
	}
	https := yesNo(st.HTTPS)
	if st.Host != "" {
		https += " (" + st.Host + ")"
	}
	serving := yesNo(st.Serving)
	if st.Serving {
		serving += " (" + st.URL + ")"
	}
	rows := [][2]string{
		{"installed", yesNo(st.Installed)},
		{"running", yesNo(st.Running)},
		{"signed_in", signedIn},
		{"https", https},
		{"serving", serving},
	}
	if st.Detail != "" {
		rows = append(rows, [2]string{"detail", st.Detail})
	}
	return rows
}

func yesNo(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

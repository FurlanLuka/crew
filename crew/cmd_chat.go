package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/chat"
)

const chatUsage = "Usage: crew chat add [--dir=<path>] [--name=<name>] | rm <id>"

// cmdChat: the plain Claude sessions Voice OS runs beside the worktrees.
func cmdChat() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, chatUsage)
		os.Exit(1)
	}
	switch os.Args[2] {
	case "add":
		chatAdd(os.Args[3:])
	case "rm":
		chatRm(os.Args[3:])
	default:
		fmt.Fprintln(os.Stderr, chatUsage)
		os.Exit(1)
	}
}

// parseChatAddArgs: --dir and --name, nothing else. Pure.
func parseChatAddArgs(args []string) (dir, name string, err error) {
	for _, a := range args {
		if v, ok := strings.CutPrefix(a, "--dir="); ok {
			dir = v
		} else if v, ok := strings.CutPrefix(a, "--name="); ok {
			name = v
		} else {
			return "", "", fmt.Errorf("unknown argument %q", a)
		}
	}
	return dir, name, nil
}

func chatAdd(args []string) {
	dir, name, err := parseChatAddArgs(args)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n%s\n", err, chatUsage)
		os.Exit(1)
	}
	added, err := chat.Add(dir, name)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Fprintf(human, "added\t%s\t%s\n", added.Ref(), added.Dir)
	if jsonOutput {
		printJSON(added)
	}
}

func chatRm(args []string) {
	if len(args) != 1 {
		fmt.Fprintln(os.Stderr, chatUsage)
		os.Exit(1)
	}
	removed, err := chat.Remove(args[0])
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Fprintf(human, "removed\t%s\t(the folder %s is untouched)\n", removed.Ref(), removed.Dir)
	if jsonOutput {
		printJSON(removed)
	}
}

func cmdLsChats() {
	chats, err := chat.List()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if jsonOutput {
		printJSON(chats)
		return
	}
	for _, c := range chats {
		fmt.Printf("%s\t%s\t%s\n", c.Ref(), c.Name, c.Dir)
	}
}

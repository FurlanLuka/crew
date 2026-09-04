package main

import (
	"fmt"
	"os"
	"strings"
	"syscall"

	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/exec"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

func cmdLaunch() {
	if len(os.Args) < 3 {
		runTUI(workspace.NewView())
		return
	}

	runTUI(workspace.NewWorktreeView(mustResolve(os.Args[2]).Ref))
}

// cmdClaude is the worktree page's "Claude in terminal" as a command: the
// same claude invocation, replacing this process.
func cmdClaude() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew claude <workspace>[/<worktree>]\n")
		os.Exit(1)
	}
	res := mustResolve(os.Args[2])
	cmd, err := workspace.ClaudeCommand(res)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if err := os.Chdir(cmd.Dir); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	debug.Log("claude", "exec %s in %s", strings.Join(cmd.Args, " "), cmd.Dir)
	if err := syscall.Exec(cmd.Path, cmd.Args, os.Environ()); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

// cmdEdit is the page's "Editor + Claude": the local editor opened on the
// worktree with the orientation prompt and Claude task in place.
func cmdEdit() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "Usage: crew edit <workspace>[/<worktree>] [--editor=cursor|code]\n")
		os.Exit(1)
	}
	editor := ""
	for _, arg := range os.Args[3:] {
		switch {
		case strings.HasPrefix(arg, "--editor="):
			editor = strings.TrimPrefix(arg, "--editor=")
		default:
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\n", arg)
			os.Exit(1)
		}
	}
	if editor == "" {
		editor = exec.DetectEditor()
	}
	if editor == "" {
		fmt.Fprintf(os.Stderr, "Error: no editor found — install Cursor or VS Code, or pass --editor\n")
		os.Exit(1)
	}
	if editor != "cursor" && editor != "code" {
		fmt.Fprintf(os.Stderr, "Error: --editor must be cursor or code\n")
		os.Exit(1)
	}
	res := mustResolve(os.Args[2])
	if err := workspace.LaunchEditor(res, editor); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Opened %s in %s\n", res.Ref, editor)
}

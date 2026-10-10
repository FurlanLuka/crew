package main

import (
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/voice"
	"github.com/FurlanLuka/crew/crew/internal/workspace"
)

// linkOutput is `crew server link <ref> --json`.
type linkOutput struct {
	URL string `json:"url"`
}

// logsPageURL is the page's logs view of a worktree, opened on one tab
// (`server:<project>/<server>` or `setup:<project>`) when given. Pure.
func logsPageURL(base string, ref workspace.Ref, tab string) string {
	path := "/setup/worktree/" + url.PathEscape(ref.Workspace) + "/" + url.PathEscape(ref.Worktree) + "/logs"
	link := strings.TrimSuffix(base, "/") + path
	if tab != "" {
		link += "?tab=" + url.QueryEscape(tab)
	}
	return link
}

// voiceLink prints where crew's page shows a worktree's logs — what the
// crew pane in a Claude session links. Only where the page runs on this
// machine: the address is localhost, without the sign-in token.
func voiceLink(args []string) {
	refArg, tab := "", ""
	for _, arg := range args {
		switch {
		case strings.HasPrefix(arg, "--tab="):
			tab = strings.TrimPrefix(arg, "--tab=")
		case strings.HasPrefix(arg, "-"):
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\n", arg)
			os.Exit(1)
		case refArg == "":
			refArg = arg
		default:
			fmt.Fprintf(os.Stderr, "Usage: crew server link <workspace>[/<worktree>] [--tab=<tab>]\n")
			os.Exit(1)
		}
	}
	if refArg == "" {
		fmt.Fprintf(os.Stderr, "Usage: crew server link <workspace>[/<worktree>] [--tab=<tab>]\n")
		os.Exit(1)
	}
	res := mustResolve(refArg)
	base := voice.PageURL()
	if base == "" {
		fmt.Fprintf(os.Stderr, "crew's page isn't running on this machine — crew server start\n")
		os.Exit(1)
	}
	link := logsPageURL(base, res.Ref, tab)
	if jsonOutput {
		printJSON(linkOutput{URL: link})
		return
	}
	fmt.Println(link)
}

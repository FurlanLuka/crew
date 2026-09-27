package help

import (
	"os"
	"path/filepath"
	"testing"
)

var commandsDoc = filepath.Join("..", "..", "..", "docs", "commands.md")

// docs/commands.md is generated from the help tree; a command change that
// forgets it fails here instead of shipping a stale page.
func TestCommandsDocIsCurrent(t *testing.T) {
	want := RenderMarkdown(Root)
	if os.Getenv("UPDATE_DOCS") == "1" {
		if err := os.WriteFile(commandsDoc, []byte(want), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	got, err := os.ReadFile(commandsDoc)
	if err != nil {
		t.Fatalf("docs/commands.md: %v — generate it with UPDATE_DOCS=1 go test ./internal/help -run TestCommandsDocIsCurrent", err)
	}
	if string(got) != want {
		t.Error("docs/commands.md is stale — regenerate it with UPDATE_DOCS=1 go test ./internal/help -run TestCommandsDocIsCurrent")
	}
}

func TestRenderMarkdown(t *testing.T) {
	root := CommandInfo{
		Name:        "crew",
		Description: "Root.",
		Subcommands: []CommandInfo{
			{
				Name:        "dev",
				Description: "Dev servers.",
				Subcommands: []CommandInfo{{
					Name:         "logs",
					Description:  "Print a log.",
					Usage:        "crew dev logs <ref> <server>",
					OutputFormat: "<line>",
					Flags: []FlagInfo{
						{Name: "--lines=<n>", Description: "Only the end", Default: "all"},
						{Name: "--server", Description: "Which one", Required: true},
					},
					Notes:    []string{"Truncated per run."},
					Examples: []string{"crew dev logs store-front api"},
					Subcommands: []CommandInfo{{
						Name:        "tail",
						Description: "Follow.",
						Subcommands: []CommandInfo{{Name: "deep", Description: "Past the cap."}},
					}},
				}},
			},
			{Name: "workspace", Description: "The TUI.", TUI: true},
		},
	}

	got := RenderMarkdown(root)

	want := DocsHeader + `
# Commands

Root.

Lists print tab-separated rows; ` + "`--json`" + ` gives the same data as JSON. ` + "`crew help <command>`" + ` prints the same page in the terminal.

## ` + "`crew dev`" + `

Dev servers.

### ` + "`crew dev logs`" + `

Print a log.

` + "```" + `
crew dev logs <ref> <server>
` + "```" + `

Output: ` + "`<line>`" + `

- ` + "`--lines=<n>`" + ` — Only the end (default all)
- ` + "`--server`" + ` — Which one (required)

Truncated per run.

` + "```bash" + `
crew dev logs store-front api
` + "```" + `

#### ` + "`crew dev logs tail`" + `

Follow.

#### ` + "`crew dev logs tail deep`" + `

Past the cap.

## ` + "`crew workspace`" + `

*Interactive (TUI).*

The TUI.
`
	if got != want {
		t.Errorf("RenderMarkdown mismatch.\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}

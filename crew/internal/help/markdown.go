package help

import (
	"fmt"
	"strings"
)

// DocsHeader opens docs/commands.md: the page is generated, so an edit there
// would be lost — the help tree is where a command's words live.
const DocsHeader = "<!-- Generated from crew's help (crew/internal/help). Do not edit: change help.go, then run\n" +
	"     UPDATE_DOCS=1 go test ./internal/help -run TestCommandsDocIsCurrent (from crew/). -->\n"

// RenderMarkdown is the command reference as a page: every command under root,
// in help order, with the same words `crew help` prints. Pure.
func RenderMarkdown(root CommandInfo) string {
	var b strings.Builder
	b.WriteString(DocsHeader)
	b.WriteString("\n# Commands\n\n")
	b.WriteString(root.Description + "\n\n")
	b.WriteString("Lists print tab-separated rows; `--json` gives the same data as JSON. `crew help <command>` prints the same page in the terminal.\n")
	for _, cmd := range root.Subcommands {
		renderCommand(&b, cmd, []string{root.Name}, 2)
	}
	return b.String()
}

func renderCommand(b *strings.Builder, cmd CommandInfo, parents []string, depth int) {
	path := append(append([]string{}, parents...), cmd.Name)
	heading := strings.Repeat("#", min(depth, 4))
	fmt.Fprintf(b, "\n%s `%s`\n\n", heading, strings.Join(path, " "))
	if cmd.TUI {
		b.WriteString("*Interactive (TUI).*\n\n")
	}
	b.WriteString(cmd.Description + "\n")
	if cmd.Usage != "" {
		fmt.Fprintf(b, "\n```\n%s\n```\n", cmd.Usage)
	}
	if cmd.OutputFormat != "" {
		fmt.Fprintf(b, "\nOutput: `%s`\n", cmd.OutputFormat)
	}
	if len(cmd.Flags) > 0 {
		b.WriteString("\n")
		for _, flag := range cmd.Flags {
			line := fmt.Sprintf("- `%s` — %s", flag.Name, flag.Description)
			if flag.Required {
				line += " (required)"
			}
			if flag.Default != "" {
				line += fmt.Sprintf(" (default %s)", flag.Default)
			}
			b.WriteString(line + "\n")
		}
	}
	for _, note := range cmd.Notes {
		fmt.Fprintf(b, "\n%s\n", note)
	}
	if len(cmd.Examples) > 0 {
		b.WriteString("\n```bash\n" + strings.Join(cmd.Examples, "\n") + "\n```\n")
	}
	for _, sub := range cmd.Subcommands {
		renderCommand(b, sub, path, depth+1)
	}
}

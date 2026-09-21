package exec

import (
	"os"
	"strings"
)

// ShellQuote wraps a string in single quotes, escaping embedded single quotes.
// Every value crew interpolates into a shell command line goes through this —
// dev server env values, file paths sent to tmux, arguments built for claude.
func ShellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'"
}

// CrewBinary is the crew executable, for the panes crew launches with its
// own commands — the proxy, the setup runners. A variable: under go test
// os.Executable is the test binary, which would re-run the package inside
// the pane, so tests point this elsewhere.
var CrewBinary = os.Executable

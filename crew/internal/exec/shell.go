package exec

import "strings"

// ShellQuote wraps a string in single quotes, escaping embedded single quotes.
// Every value crew interpolates into a shell command line goes through this —
// dev server env values, file paths sent to tmux, arguments built for claude.
func ShellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'"
}

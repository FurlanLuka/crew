package exec

import "testing"

func TestShellQuote(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"/tmp/plain", "'/tmp/plain'"},
		{"/tmp/it's here", `'/tmp/it'"'"'s here'`},
		{"", "''"},
		{"http://localhost:54021", "'http://localhost:54021'"},
		{"a b c", "'a b c'"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			if got := ShellQuote(tt.input); got != tt.want {
				t.Errorf("ShellQuote(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

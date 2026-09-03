package dev

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseEnvFile(t *testing.T) {
	tests := []struct {
		name    string
		content string
		key     string
		want    string
		absent  bool
	}{
		{name: "plain", content: "API_URL=http://localhost:3000", key: "API_URL", want: "http://localhost:3000"},
		{name: "blank lines ignored", content: "\n\nA=1\n\n", key: "A", want: "1"},
		{name: "comment ignored", content: "# A=1\nB=2", key: "A", absent: true},
		{name: "comment does not eat next line", content: "# note\nB=2", key: "B", want: "2"},
		{name: "empty value", content: "A=", key: "A", want: ""},
		{name: "no equals is skipped", content: "JUST_A_WORD", key: "JUST_A_WORD", absent: true},
		{name: "value keeps later equals", content: "A=a=b", key: "A", want: "a=b"},
		{name: "double quotes stripped", content: `A="quoted"`, key: "A", want: "quoted"},
		{name: "single quotes stripped", content: "A='quoted'", key: "A", want: "quoted"},
		{name: "inner quotes kept", content: `A=say "hi"`, key: "A", want: `say "hi"`},
		{name: "CRLF trimmed", content: "A=1\r\nB=2\r\n", key: "A", want: "1"},
		{name: "leading whitespace", content: "   A=1", key: "A", want: "1"},
		{name: "surrounding whitespace on value", content: "A=  1  ", key: "A", want: "1"},
		{name: "later duplicate wins", content: "A=first\nA=second", key: "A", want: "second"},
		// `export A=1` parses to a key of "export A", which contains a space and
		// is therefore skipped rather than silently recorded under a bogus name.
		{name: "export form skipped", content: "export A=1", key: "A", absent: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ParseEnvFile(tt.content)
			value, ok := got[tt.key]

			if tt.absent {
				if ok {
					t.Errorf("%s = %q, want it absent", tt.key, value)
				}
				return
			}
			if !ok {
				t.Fatalf("%s missing from %+v", tt.key, got)
			}
			if value != tt.want {
				t.Errorf("%s = %q, want %q", tt.key, value, tt.want)
			}
		})
	}
}

func TestReadEnvValues(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, ".env"), []byte("A=base\nB=base"), 0o644)
	os.WriteFile(filepath.Join(dir, ".env.local"), []byte("B=local"), 0o644)

	got := ReadEnvValues(dir)
	if got["A"] != "base" {
		t.Errorf("A = %q, want base", got["A"])
	}
	if got["B"] != "local" {
		t.Errorf("B = %q, want local — .env.local takes precedence", got["B"])
	}
}

func TestReadEnvValues_NoFiles(t *testing.T) {
	if got := ReadEnvValues(t.TempDir()); len(got) != 0 {
		t.Errorf("got %+v, want empty for a directory with no env files", got)
	}
}

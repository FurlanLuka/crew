package words

import "testing"

func TestCount(t *testing.T) {
	for _, tt := range []struct {
		got, want string
	}{
		{Count(0, "project"), "0 projects"},
		{Count(1, "project"), "1 project"},
		{Count(2, "workspace"), "2 workspaces"},
		{Count(1, "entry"), "1 entry"},
		{CountOf(3, "entry", "entries"), "3 entries"},
		{CountOf(1, "entry", "entries"), "1 entry"},
	} {
		if tt.got != tt.want {
			t.Errorf("%q, want %q", tt.got, tt.want)
		}
	}
}

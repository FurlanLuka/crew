package exec

import "testing"

// debug.log never records a binding's value: send-keys lines keep the
// variable names of their exports and lose the values.
func TestRedactExports(t *testing.T) {
	for _, tt := range []struct {
		name, in, want string
	}{
		{"server command", "export API_URL='http://localhost:61039'; PORT=61038 bun run dev", "export API_URL=…; PORT=61038 bun run dev"},
		{"several", "export A='x'; export B=plain; PORT=1 make dev", "export A=…; export B=…; PORT=1 make dev"},
		{"quote inside a value", `export TOKEN='it'\''s secret'; PORT=1 x`, "export TOKEN=…; PORT=1 x"},
		{"double quotes", `export K="a \"b\" c"; run`, "export K=…; run"},
		{"empty value", "export EMPTY=; run", "export EMPTY=; run"},
		{"no exports", "PORT=3000 pnpm dev", "PORT=3000 pnpm dev"},
		{"not an export word", "reexport X=1; myexport Y=2", "reexport X=1; myexport Y=2"},
		{"export without assignment", "export PATH; run", "export PATH; run"},
		{"unterminated quote", "export K='never closed", "export K=…"},
		{"after &&", "cd /x && export K=v && run", "cd /x && export K=… && run"},
	} {
		if got := RedactExports(tt.in); got != tt.want {
			t.Errorf("%s: %q → %q, want %q", tt.name, tt.in, got, tt.want)
		}
	}
}

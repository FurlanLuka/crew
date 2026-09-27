package voice

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func isolateKeys(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("VOICEOS_KEYS_DIR", filepath.Join(dir, "keys"))
	t.Setenv("VOICEOS_ANTHROPIC_API_KEY", "")
	t.Setenv("SONIOX_API_KEY", "")
	return filepath.Join(dir, "keys")
}

func TestSaveKey_OwnerOnlyAndTrimmed(t *testing.T) {
	dir := isolateKeys(t)

	if err := SaveKey("anthropic", "  sk-test \n"); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(filepath.Join(dir, "anthropic.key"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "sk-test\n" {
		t.Errorf("saved %q, want %q", data, "sk-test\n")
	}
	info, _ := os.Stat(filepath.Join(dir, "anthropic.key"))
	if info.Mode().Perm() != 0o600 {
		t.Errorf("key file mode %v, want 0600", info.Mode().Perm())
	}
	dirInfo, _ := os.Stat(dir)
	if dirInfo.Mode().Perm() != 0o700 {
		t.Errorf("keys dir mode %v, want 0700", dirInfo.Mode().Perm())
	}
}

func TestSaveKey_Refusals(t *testing.T) {
	isolateKeys(t)

	if err := SaveKey("openai", "x"); err == nil {
		t.Error("an unknown key name was saved")
	}
	if err := SaveKey("soniox", "   "); err == nil {
		t.Error("an empty key was saved")
	}
}

func TestInspectKeys_FileThenEnvThenMissing(t *testing.T) {
	isolateKeys(t)

	if got := MissingKeys(); len(got) != 2 {
		t.Fatalf("missing = %v, want both", got)
	}

	if err := SaveKey("anthropic", "sk-test"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SONIOX_API_KEY", "from-env")

	byName := map[string]KeyStatus{}
	for _, st := range InspectKeys() {
		byName[st.Name] = st
	}
	if st := byName["anthropic"]; !st.Set || st.Source != "file" {
		t.Errorf("anthropic = %+v, want set from file", st)
	}
	if st := byName["soniox"]; !st.Set || st.Source != "env" {
		t.Errorf("soniox = %+v, want set from env", st)
	}
	if got := MissingKeys(); len(got) != 0 {
		t.Errorf("missing = %v, want none", got)
	}
}

func TestCheckKey(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		wantErr error
		wantOK  bool
	}{
		{"accepted", http.StatusOK, nil, true},
		{"401 → rejected", http.StatusUnauthorized, ErrKeyRejected, false},
		{"403 → rejected", http.StatusForbidden, ErrKeyRejected, false},
		{"an outage → could not verify, not rejected", http.StatusServiceUnavailable, nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var gotAuth string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotAuth = r.Header.Get("x-api-key")
				w.WriteHeader(tc.status)
			}))
			defer server.Close()
			saved := keyCheckURL["anthropic"]
			keyCheckURL["anthropic"] = server.URL
			defer func() { keyCheckURL["anthropic"] = saved }()

			err := CheckKey("anthropic", "sk-test")

			if gotAuth != "sk-test" {
				t.Errorf("sent x-api-key %q", gotAuth)
			}
			switch {
			case tc.wantOK && err != nil:
				t.Errorf("err = %v, want nil", err)
			case tc.wantErr != nil && !errors.Is(err, tc.wantErr):
				t.Errorf("err = %v, want %v", err, tc.wantErr)
			case !tc.wantOK && tc.wantErr == nil && (err == nil || errors.Is(err, ErrKeyRejected)):
				t.Errorf("err = %v, want a could-not-verify error", err)
			}
		})
	}
}

func TestCheckKey_SonioxBearer(t *testing.T) {
	var gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
	}))
	defer server.Close()
	saved := keyCheckURL["soniox"]
	keyCheckURL["soniox"] = server.URL
	defer func() { keyCheckURL["soniox"] = saved }()

	if err := CheckKey("soniox", "so-test"); err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer so-test" {
		t.Errorf("Authorization = %q", gotAuth)
	}
}

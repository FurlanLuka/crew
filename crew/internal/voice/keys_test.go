package voice

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
)

func isolateKeys(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("VOICEOS_KEYS_DIR", filepath.Join(dir, "keys"))
	t.Setenv("VOICEOS_ANTHROPIC_API_KEY", "")
	t.Setenv("SONIOX_API_KEY", "")
	t.Setenv("ANTHROPIC_API_KEY", "")
	savedDir := config.ConfigDir
	config.ConfigDir = t.TempDir()
	t.Cleanup(func() { config.ConfigDir = savedDir })
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

	// Both for one key: the file is what Voice OS reads first.
	t.Setenv("VOICEOS_ANTHROPIC_API_KEY", "from-env")
	for _, st := range InspectKeys() {
		if st.Name == "anthropic" && st.Source != "file" {
			t.Errorf("anthropic with a file and env = %+v, want source file", st)
		}
	}
}

// An exported ANTHROPIC_API_KEY bills every Claude Code session per token: it
// is never taken as Voice OS's key.
func TestInspectKeys_IgnoresTheSharedAnthropicVariable(t *testing.T) {
	isolateKeys(t)
	t.Setenv("ANTHROPIC_API_KEY", "sk-shared")

	missing := MissingKeys()

	if len(missing) == 0 || missing[0] != "anthropic" {
		t.Errorf("missing = %v, want anthropic still missing", missing)
	}
}

func pointCheckAt(t *testing.T, url string) {
	t.Helper()
	saved := keyCheckURL["anthropic"]
	keyCheckURL["anthropic"] = url
	t.Cleanup(func() { keyCheckURL["anthropic"] = saved })
}

func TestSaveChecked(t *testing.T) {
	status := func(code int) string {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(code)
		}))
		t.Cleanup(server.Close)
		return server.URL
	}
	closed := httptest.NewServer(http.NotFoundHandler())
	closedURL := closed.URL
	closed.Close()

	cases := []struct {
		name         string
		url          string
		wantSaved    bool
		wantVerified bool
		wantErr      error
	}{
		{"accepted → saved, verified", status(http.StatusOK), true, true, nil},
		{"rejected → not saved", status(http.StatusUnauthorized), false, false, ErrKeyRejected},
		{"an outage → saved unverified", status(http.StatusServiceUnavailable), true, false, nil},
		{"offline → saved unverified", closedURL, true, false, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := isolateKeys(t)
			pointCheckAt(t, tc.url)

			verified, err := SaveChecked("anthropic", " sk-test ")

			if !errors.Is(err, tc.wantErr) || (tc.wantErr == nil && err != nil) {
				t.Errorf("err = %v, want %v", err, tc.wantErr)
			}
			if verified != tc.wantVerified {
				t.Errorf("verified = %v, want %v", verified, tc.wantVerified)
			}
			_, statErr := os.Stat(filepath.Join(dir, "anthropic.key"))
			if saved := statErr == nil; saved != tc.wantSaved {
				t.Errorf("saved = %v, want %v", saved, tc.wantSaved)
			}
		})
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

package release

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
)

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "crew-release-test-*")
	if err != nil {
		panic(err)
	}
	config.ConfigDir = dir
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

func TestAssetURL(t *testing.T) {
	saved := Base
	Base = "https://github.com/example/crew/releases/download"
	defer func() { Base = saved }()

	cases := []struct{ name, want string }{
		{"crew", "https://github.com/example/crew/releases/download/v4.3.0/crew_4.3.0_darwin_arm64.tar.gz"},
		{"voiceos", "https://github.com/example/crew/releases/download/v4.3.0/voiceos_4.3.0_darwin_arm64.tar.gz"},
	}
	for _, tc := range cases {
		if got := AssetURL(tc.name, "4.3.0", "darwin", "arm64"); got != tc.want {
			t.Errorf("AssetURL(%s) = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func archive(t *testing.T, name, body string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	tw.Write([]byte(body))
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

// serve answers /asset with body (404 when body is nil).
func serve(t *testing.T, body []byte) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if body == nil || r.URL.Path != "/asset" {
			http.NotFound(w, r)
			return
		}
		w.Write(body)
	}))
	t.Cleanup(server.Close)
	return server.URL + "/asset"
}

// plainSigning lets a Mac install plain test files; signing is the one step a
// text file cannot pass.
func plainSigning(t *testing.T) {
	t.Helper()
	saved := Sign
	Sign = func(string) error { return nil }
	t.Cleanup(func() { Sign = saved })
}

// crew update's own shape: entry crew, target the running binary's path.
func TestInstallBinary_InstallsAndReplacesByRename(t *testing.T) {
	plainSigning(t)
	target := filepath.Join(t.TempDir(), "bin", "crew")

	if err := InstallBinary(serve(t, archive(t, "crew", "v1")), "crew", target); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(target); string(data) != "v1" {
		t.Fatalf("target = %q", data)
	}
	info, _ := os.Stat(target)
	if info.Mode().Perm()&0o111 == 0 {
		t.Errorf("not executable: %v", info.Mode())
	}

	// A running binary's file must be replaced, never rewritten in place (macOS kills it).
	before, _ := os.Stat(target)
	if err := InstallBinary(serve(t, archive(t, "crew", "v2")), "crew", target); err != nil {
		t.Fatal(err)
	}
	after, _ := os.Stat(target)
	if data, _ := os.ReadFile(target); string(data) != "v2" {
		t.Errorf("target = %q, want v2", data)
	}
	if os.SameFile(before, after) {
		t.Error("rewritten in place, not replaced")
	}
	if _, err := os.Stat(target + ".new"); !os.IsNotExist(err) {
		t.Error("staged file left behind")
	}
}

func TestInstallBinary_FailuresLeaveTheTargetAlone(t *testing.T) {
	full := archive(t, "crew", strings.Repeat("x", 64*1024))
	cases := []struct {
		name  string
		body  []byte
		sign  error
		wants string
	}{
		{"404 names the platform", nil, nil, runtime.GOOS + "/" + runtime.GOARCH},
		{"archive without the entry", archive(t, "README.md", "x"), nil, "no crew"},
		{"not a gzip", []byte("<html>"), nil, "unpacking"},
		{"download cut off", full[:len(full)/2], nil, "unpacking"},
		{"signing refused", archive(t, "crew", "v2"), errors.New("codesign refused"), "codesign refused"},
	}
	for _, tc := range cases {
		for _, existing := range []string{"", "old"} {
			t.Run(tc.name+" over "+map[string]string{"": "nothing", "old": "an old binary"}[existing], func(t *testing.T) {
				saved := Sign
				Sign = func(string) error { return tc.sign }
				t.Cleanup(func() { Sign = saved })
				target := filepath.Join(t.TempDir(), "crew")
				if existing != "" {
					os.WriteFile(target, []byte(existing), 0o755)
				}

				err := InstallBinary(serve(t, tc.body), "crew", target)

				if err == nil || !strings.Contains(err.Error(), tc.wants) {
					t.Errorf("err = %v, want it to mention %q", err, tc.wants)
				}
				data, readErr := os.ReadFile(target)
				switch {
				case existing == "" && !os.IsNotExist(readErr):
					t.Error("a failed install left a binary")
				case existing != "" && string(data) != existing:
					t.Errorf("target = %q, want %q kept", data, existing)
				}
				if _, err := os.Stat(target + ".new"); !os.IsNotExist(err) {
					t.Error("staged file left behind")
				}
			})
		}
	}
}

package voice

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestAssetURL(t *testing.T) {
	saved := releaseBase
	releaseBase = "https://github.com/example/crew/releases/download"
	defer func() { releaseBase = saved }()

	got := AssetURL("4.3.0", "darwin", "arm64")
	want := "https://github.com/example/crew/releases/download/v4.3.0/voiceos_4.3.0_darwin_arm64.tar.gz"
	if got != want {
		t.Errorf("AssetURL = %q, want %q", got, want)
	}
}

func buildArchive(t *testing.T, name, body string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte(body)); err != nil {
		t.Fatal(err)
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

// serveRelease answers the one asset path this platform asks for.
func serveRelease(t *testing.T, version string, archive []byte) {
	t.Helper()
	asset := "/v" + version + "/voiceos_" + version + "_" + runtime.GOOS + "_" + runtime.GOARCH + ".tar.gz"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != asset {
			http.NotFound(w, r)
			return
		}
		w.Write(archive)
	}))
	t.Cleanup(server.Close)
	saved := releaseBase
	releaseBase = server.URL
	t.Cleanup(func() { releaseBase = saved })
}

func isolateBinary(t *testing.T) string {
	t.Helper()
	saved := signBinary
	signBinary = func(string) error { return nil }
	t.Cleanup(func() { signBinary = saved })
	bin := filepath.Join(t.TempDir(), "bin", "voiceos")
	t.Setenv("CREW_VOICEOS_BIN", bin)
	return bin
}

func TestInstall_FirstRunAndReplace(t *testing.T) {
	bin := isolateBinary(t)

	serveRelease(t, "4.3.0", buildArchive(t, "voiceos", "release build"))
	if IsInstalled() {
		t.Fatal("installed before Install")
	}
	if err := Install("4.3.0"); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(bin)
	if string(data) != "release build" {
		t.Errorf("binary = %q", data)
	}
	info, _ := os.Stat(bin)
	if info.Mode().Perm()&0o111 == 0 {
		t.Errorf("binary not executable: %v", info.Mode())
	}

	// A dev build at the same path is replaced, and nothing is left beside it.
	os.WriteFile(bin, []byte("dev build"), 0o755)
	serveRelease(t, "4.4.0", buildArchive(t, "voiceos", "newer release"))
	if err := Install("4.4.0"); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(bin)
	if string(data) != "newer release" {
		t.Errorf("binary after update = %q", data)
	}
	if _, err := os.Stat(bin + ".new"); !os.IsNotExist(err) {
		t.Error("staged .new file left behind")
	}
}

func TestInstall_Failures(t *testing.T) {
	cases := []struct {
		name    string
		version string
		archive []byte
		want    string
	}{
		{"no build for this version → names the platform", "9.9.9", nil, runtime.GOOS + "/" + runtime.GOARCH},
		{"archive without voiceos", "4.3.0", nil, "no voiceos"},
		{"not a gzip", "4.3.0", []byte("<html>"), "unpacking"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			bin := isolateBinary(t)
			archive := tc.archive
			if archive == nil {
				archive = buildArchive(t, "README.md", "not the binary")
			}
			serveRelease(t, "4.3.0", archive)

			err := Install(tc.version)

			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("err = %v, want it to mention %q", err, tc.want)
			}
			if _, statErr := os.Stat(bin); !os.IsNotExist(statErr) {
				t.Error("a failed install left a binary")
			}
			if _, statErr := os.Stat(bin + ".new"); !os.IsNotExist(statErr) {
				t.Error("a failed install left a staged file")
			}
		})
	}
}

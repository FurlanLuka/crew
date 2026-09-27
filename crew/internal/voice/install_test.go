package voice

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
	"github.com/FurlanLuka/crew/crew/internal/release"
)

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

// serveRelease answers the one asset path this platform asks for, and counts
// every request so a test can prove nothing was downloaded.
func serveRelease(t *testing.T, version string, archive []byte) *int {
	t.Helper()
	requests := 0
	asset := "/v" + version + "/voiceos_" + version + "_" + runtime.GOOS + "_" + runtime.GOARCH + ".tar.gz"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.Path != asset {
			http.NotFound(w, r)
			return
		}
		w.Write(archive)
	}))
	t.Cleanup(server.Close)
	saved := release.Base
	release.Base = server.URL
	t.Cleanup(func() { release.Base = saved })
	return &requests
}

func isolateBinary(t *testing.T) string {
	t.Helper()
	saved := release.Sign
	release.Sign = func(string) error { return nil }
	t.Cleanup(func() { release.Sign = saved })
	savedDir := config.ConfigDir
	config.ConfigDir = t.TempDir()
	t.Cleanup(func() { config.ConfigDir = savedDir })
	bin := filepath.Join(t.TempDir(), "bin", "voiceos")
	t.Setenv("CREW_VOICEOS_BIN", bin)
	return bin
}

// truncated is a real archive cut off mid-stream: the download a dropped
// connection leaves.
func truncated(t *testing.T) []byte {
	archive := buildArchive(t, "voiceos", strings.Repeat("x", 64*1024))
	return archive[:len(archive)/2]
}

func TestInstall_FailedRefreshKeepsTheOldBinary(t *testing.T) {
	cases := []struct {
		name    string
		version string
		archive func(t *testing.T) []byte
	}{
		{"no build for this version", "9.9.9", func(t *testing.T) []byte { return buildArchive(t, "voiceos", "x") }},
		{"archive without voiceos", "4.3.0", func(t *testing.T) []byte { return buildArchive(t, "README.md", "x") }},
		{"not a gzip", "4.3.0", func(*testing.T) []byte { return []byte("<html>") }},
		{"download cut off", "4.3.0", truncated},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			bin := isolateBinary(t)
			os.MkdirAll(filepath.Dir(bin), 0o755)
			os.WriteFile(bin, []byte("old build"), 0o755)
			os.WriteFile(bin+".version", []byte("4.2.0\n"), 0o644)
			serveRelease(t, "4.3.0", tc.archive(t))

			if _, err := Refresh(tc.version); err == nil {
				t.Fatal("Refresh succeeded")
			}

			// The stamp still names the old release, so the next crew update retries.
			if stamp, _ := os.ReadFile(bin + ".version"); strings.TrimSpace(string(stamp)) != "4.2.0" {
				t.Errorf("stamp = %q, want 4.2.0 kept", stamp)
			}

			if data, _ := os.ReadFile(bin); string(data) != "old build" {
				t.Errorf("binary = %q, want the old build kept", data)
			}
			if _, err := os.Stat(bin + ".new"); !os.IsNotExist(err) {
				t.Error("staged file left behind")
			}
		})
	}
}

func TestEnsureInstalled(t *testing.T) {
	t.Run("dev crew, nothing installed → ErrDevBuild, no download", func(t *testing.T) {
		bin := isolateBinary(t)
		requests := serveRelease(t, "4.3.0", buildArchive(t, "voiceos", "x"))

		if _, err := EnsureInstalled("dev", func() {}); !errors.Is(err, ErrDevBuild) {
			t.Errorf("err = %v, want ErrDevBuild", err)
		}
		if *requests != 0 {
			t.Errorf("%d requests, want none", *requests)
		}
		if _, err := os.Stat(bin); !os.IsNotExist(err) {
			t.Error("something was installed")
		}
	})
	t.Run("already installed → kept, no download (a build from source stays)", func(t *testing.T) {
		bin := isolateBinary(t)
		os.MkdirAll(filepath.Dir(bin), 0o755)
		os.WriteFile(bin, []byte("dev build"), 0o755)
		requests := serveRelease(t, "4.3.0", buildArchive(t, "voiceos", "x"))

		for _, version := range []string{"dev", "4.3.0"} {
			if downloaded, err := EnsureInstalled(version, func() {}); err != nil || downloaded {
				t.Errorf("%s: downloaded=%v err=%v, want neither", version, downloaded, err)
			}
		}
		if *requests != 0 {
			t.Errorf("%d requests, want none", *requests)
		}
	})
	t.Run("release crew, nothing installed → downloads its own version", func(t *testing.T) {
		bin := isolateBinary(t)
		serveRelease(t, "4.3.0", buildArchive(t, "voiceos", "release build"))

		announced := false
		downloaded, err := EnsureInstalled("4.3.0", func() { announced = true })

		if err != nil || !downloaded || !announced {
			t.Fatalf("downloaded=%v announced=%v err=%v", downloaded, announced, err)
		}
		if data, _ := os.ReadFile(bin); string(data) != "release build" {
			t.Errorf("binary = %q", data)
		}
	})
}

func TestRefresh(t *testing.T) {
	t.Run("never installed → nothing downloaded: crew update never adds Voice OS", func(t *testing.T) {
		bin := isolateBinary(t)
		requests := serveRelease(t, "4.3.0", buildArchive(t, "voiceos", "x"))

		updated, err := Refresh("4.3.0")

		if updated || err != nil {
			t.Errorf("updated=%v err=%v, want neither", updated, err)
		}
		if *requests != 0 {
			t.Errorf("%d requests, want none", *requests)
		}
		if _, err := os.Stat(bin); !os.IsNotExist(err) {
			t.Error("Voice OS was installed by an update")
		}
	})
	t.Run("already that release → nothing downloaded", func(t *testing.T) {
		isolateBinary(t)
		serveRelease(t, "4.3.0", buildArchive(t, "voiceos", "x"))
		if err := Install("4.3.0"); err != nil {
			t.Fatal(err)
		}
		requests := serveRelease(t, "4.3.0", buildArchive(t, "voiceos", "x"))

		updated, err := Refresh("4.3.0")

		if updated || err != nil || *requests != 0 {
			t.Errorf("updated=%v err=%v requests=%d, want nothing done", updated, err, *requests)
		}
	})
	t.Run("an older release or a build from source (no stamp) → replaced", func(t *testing.T) {
		bin := isolateBinary(t)
		serveRelease(t, "4.2.0", buildArchive(t, "voiceos", "old release"))
		if err := Install("4.2.0"); err != nil {
			t.Fatal(err)
		}
		serveRelease(t, "4.3.0", buildArchive(t, "voiceos", "new release"))

		if updated, err := Refresh("4.3.0"); !updated || err != nil {
			t.Fatalf("older: updated=%v err=%v", updated, err)
		}
		if data, _ := os.ReadFile(bin); string(data) != "new release" {
			t.Errorf("binary = %q", data)
		}

		os.WriteFile(bin, []byte("dev build"), 0o755)
		os.Remove(bin + ".version")
		if updated, err := Refresh("4.3.0"); !updated || err != nil {
			t.Fatalf("no stamp: updated=%v err=%v", updated, err)
		}
		if stamp, _ := os.ReadFile(bin + ".version"); strings.TrimSpace(string(stamp)) != "4.3.0" {
			t.Errorf("stamp = %q, want 4.3.0", stamp)
		}
	})
	t.Run("installed → replaced by that version", func(t *testing.T) {
		bin := isolateBinary(t)
		os.MkdirAll(filepath.Dir(bin), 0o755)
		os.WriteFile(bin, []byte("old build"), 0o755)
		serveRelease(t, "4.3.0", buildArchive(t, "voiceos", "new build"))

		updated, err := Refresh("4.3.0")

		if !updated || err != nil {
			t.Fatalf("updated=%v err=%v", updated, err)
		}
		if data, _ := os.ReadFile(bin); string(data) != "new build" {
			t.Errorf("binary = %q", data)
		}
	})
}

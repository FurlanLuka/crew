// Package release installs binaries from crew's GitHub releases: crew itself
// on `crew update`, and Voice OS, which rides the same tag.
package release

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	osexec "os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
)

// Base is a var so tests serve archives from a local server.
var Base = "https://github.com/" + config.Repo + "/releases/download"

var client = &http.Client{Timeout: 10 * time.Minute}

// AssetURL is where an archive of a release lives: <name>_<version>_<os>_<arch>.tar.gz,
// the GoReleaser layout voiceos/scripts/build-release.ts follows too.
func AssetURL(name, version, goos, goarch string) string {
	return fmt.Sprintf("%s/v%s/%s_%s_%s_%s.tar.gz", Base, version, name, version, goos, goarch)
}

// InstallBinary downloads the archive at url and puts its entry at target.
// On any failure target is left as it was and nothing is left beside it.
func InstallBinary(url, entry, target string) error {
	debug.Log("release", "download %s", url)
	resp, err := client.Get(url)
	if err != nil {
		debug.Log("release", "download failed: %v", err)
		return fmt.Errorf("downloading %s: %w", entry, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		debug.Log("release", "download failed: %d", resp.StatusCode)
		return fmt.Errorf("downloading %s: %s answered %d (no build for %s/%s in that release?)", entry, url, resp.StatusCode, runtime.GOOS, runtime.GOARCH)
	}

	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	// Staged beside the target and renamed over it: macOS kills a binary whose
	// file is rewritten in place, and the same directory keeps the rename on
	// one filesystem.
	staged := target + ".new"
	if err := extractEntry(resp.Body, entry, staged); err != nil {
		os.Remove(staged)
		debug.Log("release", "extract failed: %v", err)
		return fmt.Errorf("unpacking %s: %w", entry, err)
	}
	// Signed before the swap: an unsigned binary in place would pass for
	// installed and be killed at start.
	if err := Sign(staged); err != nil {
		os.Remove(staged)
		return err
	}
	if err := os.Rename(staged, target); err != nil {
		os.Remove(staged)
		return fmt.Errorf("installing %s: %w", entry, err)
	}
	debug.Log("release", "installed %s at %s", entry, target)
	return nil
}

func extractEntry(archive io.Reader, entry, dest string) error {
	gz, err := gzip.NewReader(archive)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		header, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return fmt.Errorf("no %s in the archive", entry)
		}
		if err != nil {
			return err
		}
		if header.Typeflag != tar.TypeReg || filepath.Base(header.Name) != entry {
			continue
		}
		out, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, tr); err != nil {
			out.Close()
			return err
		}
		return out.Close()
	}
}

// Sign is a var so tests install plain files on a Mac.
var Sign = signAdHoc

// signAdHoc: a binary built on another machine carries no signature this Mac
// accepts; an ad-hoc one lets it run.
func signAdHoc(path string) error {
	if runtime.GOOS != "darwin" {
		return nil
	}
	debug.Log("release", "codesign --force --sign - %s", path)
	if out, err := osexec.Command("codesign", "--force", "--sign", "-", path).CombinedOutput(); err != nil {
		debug.Log("release", "codesign failed: %v: %s", err, out)
		return fmt.Errorf("signing %s: %v", filepath.Base(path), err)
	}
	return nil
}

// IsDevBuild: a build from source — plain "dev", or "dev-<sha>" from crew voice
// dev push. There is no release to update to or from. Pure.
func IsDevBuild(version string) bool {
	return version == "dev" || strings.HasPrefix(version, "dev-")
}

package voice

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
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
)

// Voice OS ships in crew's own release, one archive per platform, so the
// Voice OS a crew downloads always matches that crew: they talk to each other.
const binaryName = "voiceos"

// releaseBase is a var so tests serve archives from a local server.
var releaseBase = "https://github.com/" + config.Repo + "/releases/download"

var installClient = &http.Client{Timeout: 10 * time.Minute}

// AssetURL is where the Voice OS build for a platform lives in a release. Pure.
func AssetURL(version, goos, goarch string) string {
	return fmt.Sprintf("%s/v%s/%s_%s_%s_%s.tar.gz", releaseBase, version, binaryName, version, goos, goarch)
}

func IsInstalled() bool {
	_, err := os.Stat(Binary())
	return err == nil
}

// Install puts the Voice OS of that crew version at Binary(), replacing any
// build already there — a dev build included. A running Voice OS keeps the
// file it started from; the new one is used from the next start.
func Install(version string) error {
	url := AssetURL(version, runtime.GOOS, runtime.GOARCH)
	debug.Log("voice", "download %s", url)
	resp, err := installClient.Get(url)
	if err != nil {
		debug.Log("voice", "download failed: %v", err)
		return fmt.Errorf("downloading Voice OS: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		debug.Log("voice", "download failed: %d", resp.StatusCode)
		return fmt.Errorf("downloading Voice OS: %s answered %d (no build for %s/%s in v%s?)", url, resp.StatusCode, runtime.GOOS, runtime.GOARCH, version)
	}

	target := Binary()
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	// Written beside the old binary and renamed over it: macOS kills a signed
	// binary that is rewritten in place, a new file under the same name is fine.
	staged := target + ".new"
	if err := extractBinary(resp.Body, staged); err != nil {
		os.Remove(staged)
		debug.Log("voice", "extract failed: %v", err)
		return fmt.Errorf("unpacking Voice OS: %w", err)
	}
	if err := os.Rename(staged, target); err != nil {
		os.Remove(staged)
		return fmt.Errorf("installing Voice OS: %w", err)
	}
	debug.Log("voice", "installed v%s at %s", version, target)
	return signBinary(target)
}

// extractBinary writes the archive's voiceos entry to dest, executable.
func extractBinary(archive io.Reader, dest string) error {
	gz, err := gzip.NewReader(archive)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		header, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return fmt.Errorf("no %s in the archive", binaryName)
		}
		if err != nil {
			return err
		}
		if header.Typeflag != tar.TypeReg || filepath.Base(header.Name) != binaryName {
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

// signBinary is a var so tests install plain files on a Mac.
var signBinary = signAdHoc

// signAdHoc: a binary built on another machine carries no signature this Mac
// accepts; an ad-hoc one lets it run.
func signAdHoc(path string) error {
	if runtime.GOOS != "darwin" {
		return nil
	}
	debug.Log("voice", "codesign --force --sign - %s", path)
	if out, err := osexec.Command("codesign", "--force", "--sign", "-", path).CombinedOutput(); err != nil {
		debug.Log("voice", "codesign failed: %v: %s", err, out)
		return fmt.Errorf("signing Voice OS: %v", err)
	}
	return nil
}

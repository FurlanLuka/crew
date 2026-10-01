package voice

import (
	"errors"
	"os"
	"runtime"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/release"
)

const binaryName = "voiceos"

// ErrDevBuild: a crew built from source has no release to take Voice OS from.
var ErrDevBuild = errors.New("a dev build of crew has no release to download Voice OS from")

func IsInstalled() bool {
	_, err := os.Stat(Binary())
	return err == nil
}

// stampFile records which release is installed; a build from source has none.
func stampFile() string { return Binary() + ".version" }

func installedVersion() string {
	data, err := os.ReadFile(stampFile())
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// Install puts the Voice OS of that crew version at Binary() — from the same
// release as crew, so the two always match — replacing whatever is there, a
// build from source included. A running Voice OS keeps the file it started
// from; the new one is used from the next start.
func Install(version string) error {
	url := release.AssetURL(binaryName, version, runtime.GOOS, runtime.GOARCH)
	if err := release.InstallBinary(url, binaryName, Binary()); err != nil {
		return err
	}
	if err := os.WriteFile(stampFile(), []byte(version+"\n"), 0o644); err != nil {
		debug.Log("voice", "version stamp not written: %v", err)
	}
	return nil
}

// EnsureInstalled is the first run: the Voice OS of that crew version, unless
// one is already there (a release or a build from source). announce is said
// just before a download starts.
func EnsureInstalled(version string, announce func()) (downloaded bool, err error) {
	if IsInstalled() {
		return false, nil
	}
	if release.IsDevBuild(version) {
		return false, ErrDevBuild
	}
	announce()
	return true, Install(version)
}

// Refresh keeps an installed Voice OS on that crew version: it downloads only
// when what is installed is not that release (a failed earlier refresh, a
// build from source), never installs one nobody asked for, and never touches
// a running one.
func Refresh(version string) (updated bool, err error) {
	if !IsInstalled() || installedVersion() == version {
		return false, nil
	}
	if err := Install(version); err != nil {
		return false, err
	}
	return true, nil
}

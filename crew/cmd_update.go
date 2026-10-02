package main

import (
	"fmt"
	"os"
	osexec "os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/release"
)

// cmdUpdate: crew update installs the latest release over this binary;
// --check only says whether there is one. It never restarts crew's server —
// that would end every Claude session in it.
func cmdUpdate() {
	check := false
	for _, arg := range os.Args[2:] {
		switch arg {
		case "--check":
			check = true
		default:
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\nUsage: crew update [--check]\n", arg)
			os.Exit(1)
		}
	}
	if check {
		latest, err := release.LatestVersion()
		if err == nil {
			release.Remember(latest, time.Now())
		}
		doc := updateCheck(Version, latest, err)
		if jsonOutput {
			printJSON(doc)
			return
		}
		fmt.Println(doc.Line)
		return
	}

	selfPath, err := osexec.LookPath("crew")
	if err != nil {
		selfPath, err = os.Executable()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: cannot determine crew binary path\n")
			os.Exit(1)
		}
	}

	latest, err := release.LatestVersion()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error fetching latest version: %v\n", err)
		os.Exit(1)
	}
	release.Remember(latest, time.Now())

	if decideUpdate(Version, latest) == updateCurrent {
		fmt.Fprintf(human, "crew is already up to date (v%s)\n", Version)
		// A Voice OS refresh that failed last time, or a build from source, is
		// brought in line even when crew itself has nothing new.
		refreshVoice(latest)
		if jsonOutput {
			printJSON(updateDoc{From: Version, To: latest})
		}
		return
	}

	fmt.Fprintln(human, updatingLine(Version, latest))
	url := release.AssetURL("crew", latest, runtime.GOOS, runtime.GOARCH)
	if err := release.InstallBinary(url, "crew", selfPath); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	fmt.Fprintf(human, "crew updated to v%s\n", latest)
	refreshVoice(latest)
	if jsonOutput {
		printJSON(updateDoc{From: Version, To: latest, Updated: true})
	}
}

// updateDoc is crew update --json: the version it ran as, the release it
// read, and whether it installed that.
type updateDoc struct {
	From    string `json:"from"`
	To      string `json:"to"`
	Updated bool   `json:"updated"`
}

// updateCheckDoc is crew update --check: this crew, the latest release, and
// whether that is newer. Offline is not a failure — nothing is available,
// and Error says why.
type updateCheckDoc struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	Available bool   `json:"available"`
	// Dev is a dev build: never "available", crew update replaces it with
	// the latest release — the page reads this rather than a rule of its own.
	Dev   bool   `json:"dev"`
	Error string `json:"error,omitempty"`
	// Line is the text crew update --check prints, so the page shows crew's
	// own wording rather than a copy of it.
	Line string `json:"line"`
}

// updateVerdict is this crew against the latest release — the one reading
// crew update and crew update --check share, so the check never offers what
// the update would not do.
type updateVerdict int

const (
	updateCurrent updateVerdict = iota // the same, or ahead: nothing to install, never a downgrade
	updateNewer                        // a newer release: crew update installs it
	updateDev                          // a dev build: not a release, crew update replaces it with the latest
)

// decideUpdate is the verdict. Pure.
func decideUpdate(current, latest string) updateVerdict {
	switch {
	case release.IsDevBuild(current):
		return updateDev
	case release.IsNewer(latest, current):
		return updateNewer
	}
	return updateCurrent
}

// updateCheck decides the doc. A dev build is never "available": a release
// is not newer than something that is not one. Pure.
func updateCheck(current, latest string, err error) updateCheckDoc {
	doc := updateCheckDoc{Current: current, Latest: latest, Dev: decideUpdate(current, latest) == updateDev}
	if err != nil {
		doc.Error = err.Error()
	} else {
		doc.Available = decideUpdate(current, latest) == updateNewer
	}
	doc.Line = updateCheckLine(doc)
	return doc
}

// devBuildLabel names a dev build without a "v" in front of a word that is
// not a version: dev → "dev build", dev-<sha>… → "dev build <sha>…".
func devBuildLabel(version string) string {
	if sha := strings.TrimPrefix(version, "dev-"); sha != version && sha != "" {
		return "dev build " + sha
	}
	return "dev build"
}

// versionLabel names this crew: v<version> for a release, the dev build
// label for anything else.
func versionLabel(version string) string {
	if release.IsDevBuild(version) {
		return devBuildLabel(version)
	}
	return "v" + version
}

// updatingLine is what crew update says before it installs. Pure.
func updatingLine(current, latest string) string {
	return fmt.Sprintf("Updating crew %s → v%s", versionLabel(current), latest)
}

// updateCheckLine is the text form. Pure.
func updateCheckLine(d updateCheckDoc) string {
	switch {
	case d.Error != "" && d.Dev:
		return fmt.Sprintf("crew (%s) — could not ask for the latest release: %s", devBuildLabel(d.Current), d.Error)
	case d.Error != "":
		return fmt.Sprintf("crew v%s — could not ask for the latest release: %s", d.Current, d.Error)
	case d.Available:
		return fmt.Sprintf("crew v%s — v%s is available (crew update)", d.Current, d.Latest)
	case d.Dev:
		return fmt.Sprintf("crew (%s) — crew update installs the latest release (v%s)", devBuildLabel(d.Current), d.Latest)
	}
	return fmt.Sprintf("crew v%s — up to date (latest v%s)", d.Current, d.Latest)
}

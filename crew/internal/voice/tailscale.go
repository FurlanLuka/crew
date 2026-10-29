package voice

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/FurlanLuka/crew/crew/internal/debug"
)

// tailscaleAppCLI is the CLI inside the Mac app, which puts nothing on PATH.
// A var so tests point it elsewhere.
var tailscaleAppCLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"

// findTailscale is the CLI to run, "" when Tailscale is not installed. A var for tests.
var findTailscale = func() string {
	if path, err := osexec.LookPath("tailscale"); err == nil {
		return path
	}
	if _, err := os.Stat(tailscaleAppCLI); err == nil {
		return tailscaleAppCLI
	}
	return ""
}

// runTailscale runs the CLI; stdout comes back even on a failure, since
// status --json still prints its document when the backend is stopped. A var for tests.
var runTailscale = func(bin string, args ...string) ([]byte, error) {
	debug.Log("voice", "tailscale: %s", strings.Join(args, " "))
	cmd := osexec.Command(bin, args...)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		debug.Log("voice", "tailscale %s: %v", args[0], err)
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			err = errors.New(msg)
		}
	}
	return out, err
}

// TailscaleServe is tailscale.json: Voice OS shared on the tailnet, at url.
// Phone links use url while it exists.
type TailscaleServe struct {
	Host string `json:"host"`
	URL  string `json:"url"`
}

// TailscaleStatus is `crew server tailscale status`.
type TailscaleStatus struct {
	Installed bool   `json:"installed"`
	Running   bool   `json:"running"`
	SignedIn  bool   `json:"signed_in"`
	User      string `json:"user"`
	Host      string `json:"host"`
	HTTPS     bool   `json:"https"`
	Serving   bool   `json:"serving"`
	URL       string `json:"url"`
	Detail    string `json:"detail"`
}

// Ready is whether serve can share Voice OS: HTTPS on a signed-in, running tailnet.
func (s TailscaleStatus) Ready() bool {
	return s.Installed && s.Running && s.SignedIn && s.HTTPS && s.Host != ""
}

func TailscaleFile() string { return filepath.Join(Dir(), "tailscale.json") }

// The parts of `tailscale status --json` crew reads.
type tsStatus struct {
	BackendState string `json:"BackendState"`
	Self         *struct {
		DNSName string `json:"DNSName"`
		UserID  int64  `json:"UserID"`
	} `json:"Self"`
	CertDomains    []string `json:"CertDomains"`
	CurrentTailnet *struct {
		Name string `json:"Name"`
	} `json:"CurrentTailnet"`
	User map[string]struct {
		LoginName string `json:"LoginName"`
	} `json:"User"`
}

// parseTailscaleStatus reads `tailscale status --json` into what crew asks
// of it, with the detail naming the first thing in the way. Pure.
func parseTailscaleStatus(out []byte, runErr error) TailscaleStatus {
	st := TailscaleStatus{Installed: true}
	var raw tsStatus
	if err := json.Unmarshal(out, &raw); err != nil || raw.BackendState == "" {
		st.Detail = "Tailscale is not running: open the Tailscale app (or run tailscale up)"
		if runErr != nil {
			st.Detail += " — " + runErr.Error()
		}
		return st
	}
	st.Running = raw.BackendState != "Stopped" && raw.BackendState != "NoState"
	st.SignedIn = raw.BackendState == "Running"
	st.HTTPS = len(raw.CertDomains) > 0
	if raw.Self != nil {
		st.Host = strings.TrimSuffix(raw.Self.DNSName, ".")
		if u, ok := raw.User[strconv.FormatInt(raw.Self.UserID, 10)]; ok {
			st.User = u.LoginName
		}
	}
	if st.User == "" && raw.CurrentTailnet != nil {
		st.User = raw.CurrentTailnet.Name
	}
	st.Detail = notReadyDetail(st)
	return st
}

func notReadyDetail(st TailscaleStatus) string {
	switch {
	case !st.Running:
		return "Tailscale is stopped: turn it on in the Tailscale app (or run tailscale up)"
	case !st.SignedIn:
		return "Tailscale is not signed in: sign in from the Tailscale app (or run tailscale up)"
	case !st.HTTPS || st.Host == "":
		return "HTTPS certificates are off for your tailnet: turn them on at https://login.tailscale.com/admin/dns"
	}
	return ""
}

// serveHas443 reads `tailscale serve status --json`: a web handler on :443. Pure.
func serveHas443(out []byte) bool {
	var raw struct {
		Web map[string]struct {
			Handlers map[string]json.RawMessage `json:"Handlers"`
		} `json:"Web"`
	}
	if err := json.Unmarshal(out, &raw); err != nil {
		return false
	}
	for hostPort, web := range raw.Web {
		if strings.HasSuffix(hostPort, ":443") && len(web.Handlers) > 0 {
			return true
		}
	}
	return false
}

// InspectTailscale is the status: what Tailscale says, and whether crew's
// share of Voice OS is up (tailscale.json written and a handler on 443).
func InspectTailscale() TailscaleStatus {
	bin := findTailscale()
	if bin == "" {
		return TailscaleStatus{Detail: "Tailscale is not installed: get it at https://tailscale.com/download and sign in"}
	}
	out, err := runTailscale(bin, "status", "--json")
	st := parseTailscaleStatus(out, err)
	saved, _ := readJSONFile[TailscaleServe](TailscaleFile())
	if saved != nil && st.Running {
		if serveOut, err := runTailscale(bin, "serve", "status", "--json"); err == nil && serveHas443(serveOut) {
			st.Serving, st.URL = true, saved.URL
		}
	}
	if st.Detail == "" && !st.Serving {
		st.Detail = "ready, not serving Voice OS yet: crew server tailscale serve"
	}
	return st
}

// ServeTailscale shares Voice OS on the tailnet over HTTPS at https://<host>
// and records it, so a phone link made after it goes there.
func ServeTailscale() (TailscaleServe, error) {
	st := InspectTailscale()
	if !st.Ready() {
		return TailscaleServe{}, fmt.Errorf("cannot serve on Tailscale yet: %s", st.Detail)
	}
	port := loadSaved().Port
	if port <= 0 {
		return TailscaleServe{}, errors.New("crew's server has not started on this machine yet — run crew server start first")
	}
	// A 443 share crew did not record is the developer's own: serving over it would replace it.
	if saved, _ := readJSONFile[TailscaleServe](TailscaleFile()); saved == nil {
		out, err := runTailscale(findTailscale(), "serve", "status", "--json")
		if err == nil && serveHas443(out) {
			return TailscaleServe{}, errors.New("something is already served on 443 of your tailnet (see tailscale serve status) — crew won't replace a share it didn't make; turn that one off first (tailscale serve --https=443 off)")
		}
	}
	target := fmt.Sprintf("http://127.0.0.1:%d", port)
	if _, err := runTailscale(findTailscale(), "serve", "--bg", "--https=443", target); err != nil {
		return TailscaleServe{}, fmt.Errorf("tailscale serve failed: %w", err)
	}
	serve := TailscaleServe{Host: st.Host, URL: "https://" + st.Host}
	if err := os.MkdirAll(Dir(), 0o700); err != nil {
		return TailscaleServe{}, err
	}
	data, err := json.MarshalIndent(serve, "", "  ")
	if err != nil {
		return TailscaleServe{}, err
	}
	if err := writeFileAtomic(TailscaleFile(), append(data, '\n')); err != nil {
		return TailscaleServe{}, err
	}
	debug.Log("voice", "tailscale: serving %s → %d", serve.Host, port)
	return serve, nil
}

// TailscaleOff stops the share and forgets it; the record goes first, so phone
// links stop pointing at the tailnet even when Tailscale itself is gone. With
// no record, 443 is left alone: a share there is the developer's own.
func TailscaleOff() ([]string, error) {
	removed := []string{}
	debug.Log("voice", "tailscale off: rm %s", TailscaleFile())
	switch err := os.Remove(TailscaleFile()); {
	case err == nil:
		removed = append(removed, TailscaleFile())
	case os.IsNotExist(err):
		return removed, nil
	default:
		return removed, err
	}
	bin := findTailscale()
	if bin == "" {
		return removed, nil
	}
	if _, err := runTailscale(bin, "serve", "--https=443", "off"); err != nil {
		return removed, fmt.Errorf("tailscale serve --https=443 off failed: %w", err)
	}
	return removed, nil
}

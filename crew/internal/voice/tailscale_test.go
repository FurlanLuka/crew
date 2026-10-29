package voice

import (
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
)

const tsRunning = `{
  "BackendState": "Running",
  "Self": {"DNSName": "mac.tail1.ts.net.", "UserID": 42},
  "CertDomains": ["mac.tail1.ts.net"],
  "CurrentTailnet": {"Name": "dev@example.com"},
  "User": {"42": {"LoginName": "dev@example.com"}}
}`

const tsServing = `{"TCP":{"443":{"HTTPS":true}},"Web":{"mac.tail1.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7300"}}}}}`

// fakeTailscale answers each command from answers, keyed by its args joined; it records every call.
type fakeTailscale struct {
	answers map[string]string
	fail    map[string]error
	calls   []string
}

func (f *fakeTailscale) install(t *testing.T) {
	t.Helper()
	savedFind, savedRun := findTailscale, runTailscale
	findTailscale = func() string { return "/fake/tailscale" }
	runTailscale = func(bin string, args ...string) ([]byte, error) {
		key := strings.Join(args, " ")
		f.calls = append(f.calls, key)
		return []byte(f.answers[key]), f.fail[key]
	}
	t.Cleanup(func() { findTailscale, runTailscale = savedFind, savedRun })
}

func TestParseTailscaleStatus_Ready(t *testing.T) {
	got := parseTailscaleStatus([]byte(tsRunning), nil)
	want := TailscaleStatus{Installed: true, Running: true, SignedIn: true, User: "dev@example.com", Host: "mac.tail1.ts.net", HTTPS: true}
	if got != want {
		t.Errorf("status = %+v, want %+v", got, want)
	}
}

func TestParseTailscaleStatus_NotReady(t *testing.T) {
	for _, tc := range []struct {
		name, out string
		err       error
		detail    string
	}{
		{"daemon down", "", errors.New("failed to connect to local Tailscale service"), "not running"},
		{"stopped", `{"BackendState":"Stopped"}`, nil, "stopped"},
		{"signed out", `{"BackendState":"NeedsLogin"}`, nil, "not signed in"},
		{"no https", `{"BackendState":"Running","Self":{"DNSName":"mac.tail1.ts.net."},"CertDomains":null}`, nil, "https://login.tailscale.com/admin/dns"},
	} {
		st := parseTailscaleStatus([]byte(tc.out), tc.err)
		if st.Ready() || !strings.Contains(st.Detail, tc.detail) {
			t.Errorf("%s: %+v, want detail with %q", tc.name, st, tc.detail)
		}
	}
}

func TestInspectTailscale_NotInstalled(t *testing.T) {
	saved := findTailscale
	findTailscale = func() string { return "" }
	t.Cleanup(func() { findTailscale = saved })
	st := InspectTailscale()
	if st.Installed || !strings.Contains(st.Detail, "not installed") {
		t.Errorf("status = %+v", st)
	}
}

func TestInspectTailscale_ServingNeedsRecordAndHandler(t *testing.T) {
	isolateConfig(t)
	f := &fakeTailscale{answers: map[string]string{"status --json": tsRunning, "serve status --json": tsServing}}
	f.install(t)

	if st := InspectTailscale(); st.Serving || !strings.Contains(st.Detail, "crew server tailscale serve") {
		t.Errorf("no record: %+v", st)
	}
	os.MkdirAll(Dir(), 0o700)
	os.WriteFile(TailscaleFile(), []byte(`{"host":"mac.tail1.ts.net","url":"https://mac.tail1.ts.net"}`), 0o600)
	if st := InspectTailscale(); !st.Serving || st.URL != "https://mac.tail1.ts.net" || st.Detail != "" {
		t.Errorf("serving: %+v", st)
	}
	f.answers["serve status --json"] = `{}`
	if st := InspectTailscale(); st.Serving {
		t.Errorf("record but no handler read as serving: %+v", st)
	}
}

func TestServeTailscale_RefusesUntilReady(t *testing.T) {
	isolateConfig(t)
	saveState(savedState{Port: 7300})
	f := &fakeTailscale{answers: map[string]string{"status --json": `{"BackendState":"Running","Self":{"DNSName":"mac.tail1.ts.net."}}`}}
	f.install(t)
	_, err := ServeTailscale()
	if err == nil || !strings.Contains(err.Error(), "HTTPS certificates are off") {
		t.Fatalf("err = %v", err)
	}
	for _, c := range f.calls {
		if strings.HasPrefix(c, "serve --bg") {
			t.Error("served while not ready")
		}
	}
	if _, err := os.Stat(TailscaleFile()); !os.IsNotExist(err) {
		t.Error("tailscale.json written on a refusal")
	}
}

func TestServeTailscale_ServesTheRememberedPort(t *testing.T) {
	isolateConfig(t)
	saveState(savedState{Port: 7300})
	f := &fakeTailscale{answers: map[string]string{"status --json": tsRunning}}
	f.install(t)
	serve, err := ServeTailscale()
	if err != nil {
		t.Fatal(err)
	}
	if want := (TailscaleServe{Host: "mac.tail1.ts.net", URL: "https://mac.tail1.ts.net"}); serve != want {
		t.Errorf("serve = %+v", serve)
	}
	if !reflect.DeepEqual(f.calls[len(f.calls)-1], "serve --bg --https=443 http://127.0.0.1:7300") {
		t.Errorf("calls = %v", f.calls)
	}
	saved, _ := readJSONFile[TailscaleServe](TailscaleFile())
	if saved == nil || *saved != serve {
		t.Errorf("tailscale.json = %+v", saved)
	}
}

func TestTailscaleOff(t *testing.T) {
	isolateConfig(t)
	f := &fakeTailscale{}
	f.install(t)

	removed, err := TailscaleOff()
	if err != nil || len(removed) != 0 || len(f.calls) != 0 {
		t.Errorf("nothing recorded: removed %v, calls %v, %v — 443 must be left alone", removed, f.calls, err)
	}

	os.MkdirAll(Dir(), 0o700)
	os.WriteFile(TailscaleFile(), []byte(`{"host":"h","url":"https://h"}`), 0o600)
	removed, err = TailscaleOff()
	if err != nil || len(removed) != 1 || !reflect.DeepEqual(f.calls, []string{"serve --https=443 off"}) {
		t.Errorf("removed %v, calls %v, %v", removed, f.calls, err)
	}
	if _, err := os.Stat(TailscaleFile()); !os.IsNotExist(err) {
		t.Error("tailscale.json kept")
	}
}

func TestServeTailscale_LeavesAForeignShareAlone(t *testing.T) {
	isolateConfig(t)
	saveState(savedState{Port: 7300})
	f := &fakeTailscale{answers: map[string]string{"status --json": tsRunning, "serve status --json": tsServing}}
	f.install(t)
	_, err := ServeTailscale()
	if err == nil || !strings.Contains(err.Error(), "tailscale serve status") || !strings.Contains(err.Error(), "won't replace") {
		t.Fatalf("err = %v", err)
	}
	for _, c := range f.calls {
		if strings.HasPrefix(c, "serve --bg") {
			t.Error("served over a share crew did not make")
		}
	}
}

func TestServeTailscale_ReservesItsOwnShare(t *testing.T) {
	isolateConfig(t)
	saveState(savedState{Port: 7300})
	os.WriteFile(TailscaleFile(), []byte(`{"host":"mac.tail1.ts.net","url":"https://mac.tail1.ts.net"}`), 0o600)
	f := &fakeTailscale{answers: map[string]string{"status --json": tsRunning, "serve status --json": tsServing}}
	f.install(t)
	if _, err := ServeTailscale(); err != nil {
		t.Fatal(err)
	}
	if last := f.calls[len(f.calls)-1]; last != "serve --bg --https=443 http://127.0.0.1:7300" {
		t.Errorf("calls = %v", f.calls)
	}
}

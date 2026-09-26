package voice

import (
	"net"
	"testing"
	"time"
)

func TestLoginURL(t *testing.T) {
	cases := []struct {
		scheme string
		host   string
		port   int
		token  string
		want   string
	}{
		{"http", "localhost", 47811, "abc", "http://localhost:47811/login?token=abc"},
		{"http", "voice--os.10.0.0.2.nip.io", 80, "abc", "http://voice--os.10.0.0.2.nip.io/login?token=abc"},
		{"https", "voice--os.10.0.0.2.nip.io", 443, "abc", "https://voice--os.10.0.0.2.nip.io/login?token=abc"},
		{"https", "voice--os.10.0.0.2.nip.io", 8443, "abc", "https://voice--os.10.0.0.2.nip.io:8443/login?token=abc"},
		{"https", "voice--os.10.0.0.2.nip.io", 80, "abc", "https://voice--os.10.0.0.2.nip.io:80/login?token=abc"},
		{"http", "localhost", 47811, "", "http://localhost:47811/"},
		{"http", "localhost", 47811, "a b&c", "http://localhost:47811/login?token=a+b%26c"},
	}
	for _, c := range cases {
		if got := LoginURL(c.scheme, c.host, c.port, c.token); got != c.want {
			t.Errorf("LoginURL(%q, %q, %d, %q) = %q, want %q", c.scheme, c.host, c.port, c.token, got, c.want)
		}
	}
}

func TestProxyLoginURL(t *testing.T) {
	cases := []struct {
		name       string
		httpsPort  int
		tlsUp      bool
		want       string
		wantSecure bool
	}{
		{"https answering → the https link", 443, true, "https://voice--os.d/login?token=t", true},
		{"https configured but not answering → plain http", 443, false, "http://voice--os.d/login?token=t", false},
		{"https off → plain http", 0, true, "http://voice--os.d/login?token=t", false},
	}
	for _, c := range cases {
		got, secure := proxyLoginURL(proxyLink{Domain: "d", Port: 80, HTTPSPort: c.httpsPort, TLSUp: c.tlsUp, Token: "t"})
		if got != c.want || secure != c.wantSecure {
			t.Errorf("%s: got %q secure=%v, want %q secure=%v", c.name, got, secure, c.want, c.wantSecure)
		}
	}
}

func TestProxyHost(t *testing.T) {
	if got := ProxyHost("10.0.0.2.nip.io"); got != "voice--os.10.0.0.2.nip.io" {
		t.Errorf("ProxyHost = %q", got)
	}
}

func TestCommand(t *testing.T) {
	got := Command(LaunchSpec{Binary: "/Users/x/.crew/bin/voiceos", CrewBin: "/usr/local/bin/crew", Home: "/Users/x", Port: 47811, ProxyHost: "voice--os.d", ProxyPort: 80})
	want := "HOME='/Users/x' CREW_BIN='/usr/local/bin/crew' PORT=47811 VOICEOS_PROXY_HOST='voice--os.d' VOICEOS_PROXY_PORT=80 VOICEOS_RECORD_STATE=1 '/Users/x/.crew/bin/voiceos'"
	if got != want {
		t.Errorf("Command =\n%s\nwant\n%s", got, want)
	}
}

func TestCommandWithHTTPS(t *testing.T) {
	got := Command(LaunchSpec{Binary: "/b/voiceos", CrewBin: "/c/crew", Home: "/h", Port: 1, ProxyHost: "voice--os.d", ProxyPort: 80, ProxyHTTPSPort: 443})
	want := "HOME='/h' CREW_BIN='/c/crew' PORT=1 VOICEOS_PROXY_HOST='voice--os.d' VOICEOS_PROXY_PORT=80 VOICEOS_PROXY_HTTPS_PORT=443 VOICEOS_RECORD_STATE=1 '/b/voiceos'"
	if got != want {
		t.Errorf("Command =\n%s\nwant\n%s", got, want)
	}
}

func TestPickPortKeepsAFreeRememberedPort(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()

	got, err := pickPort(port)
	if err != nil || got != port {
		t.Errorf("pickPort(%d) = %d, %v; want the remembered port", port, got, err)
	}
}

func TestPickPortMovesOffABusyPort(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	busy := ln.Addr().(*net.TCPAddr).Port
	withPortWait(t, 200*time.Millisecond)

	got, err := pickPort(busy)
	if err != nil || got == busy || got == 0 {
		t.Errorf("pickPort(busy %d) = %d, %v; want another free port", busy, got, err)
	}
}

// Right after a stop the old Voice OS still holds the port for a moment; the
// restart must wait for it rather than move to a new one (open tabs would break).
func TestPickPortWaitsForTheRememberedPortToFree(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	withPortWait(t, 3*time.Second)
	go func() {
		time.Sleep(300 * time.Millisecond)
		ln.Close()
	}()

	got, err := pickPort(port)
	if err != nil || got != port {
		t.Errorf("pickPort(%d) = %d, %v; want the remembered port once it freed", port, got, err)
	}
}

func withPortWait(t *testing.T, d time.Duration) {
	prev := portWait
	portWait = d
	t.Cleanup(func() { portWait = prev })
}

func TestPickPortWithNothingRemembered(t *testing.T) {
	if got, err := pickPort(0); err != nil || got == 0 {
		t.Errorf("pickPort(0) = %d, %v", got, err)
	}
}

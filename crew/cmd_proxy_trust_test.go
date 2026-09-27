package main

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/dev"
)

func TestRenderTrust(t *testing.T) {
	info := trustInfo{
		Domain:      "10.0.0.2.nip.io",
		CA:          "/h/.crew/tls/10.0.0.2.nip.io/ca.pem",
		Fingerprint: "AA:BB",
		PEMURL:      "http://10.0.0.2.nip.io/crew-ca.pem",
		HTTPSPort:   443,
		ServerIPSet: true,
	}
	want := `crew's CA for 10.0.0.2.nip.io
  file         /h/.crew/tls/10.0.0.2.nip.io/ca.pem
  SHA-256      AA:BB

Trust it once on every device that opens the proxy over HTTPS:

  This Mac     crew dev proxy trust --install   (asks for your password)
  iPhone/iPad  open http://10.0.0.2.nip.io/crew-ca.pem in Safari → Allow → Settings → Profile Downloaded → Install,
               then Settings → General → About → Certificate Trust Settings → turn on crew local CA
  Android      open http://10.0.0.2.nip.io/crew-ca.pem → install as a CA certificate (Settings → Security → Encryption & credentials)
  Other Mac    download the file, then: security add-trusted-cert -r trustRoot -p ssl -k ~/Library/Keychains/login.keychain-db crew-ca.pem

Check the SHA-256 on the device matches the one above.
`
	if got := renderTrust(info); got != want {
		t.Errorf("renderTrust =\n%s\nwant\n%s", got, want)
	}

	info.ServerIPSet, info.HTTPSPort = false, 0
	got := renderTrust(info)
	for _, part := range []string{
		"HTTPS is off (proxy_https_port = -1). Turn it on with: crew config set proxy_https_port 0\n\n",
		"! server_ip is not set, so the domain follows the detected IP and can change (LAN vs Tailscale).\n",
		"  Each domain has its own CA. Pin it: crew config set server_ip <ip>\n",
	} {
		if !strings.Contains(got, part) {
			t.Errorf("renderTrust lacks %q", part)
		}
	}
}

func TestCADownloadURL(t *testing.T) {
	if got := caDownloadURL("d.nip.io", 80); got != "http://d.nip.io/crew-ca.pem" {
		t.Errorf("port 80: %s", got)
	}
	if got := caDownloadURL("d.nip.io", 8080); got != "http://d.nip.io:8080/crew-ca.pem" {
		t.Errorf("port 8080: %s", got)
	}
}

func TestBuildTrust(t *testing.T) {
	prev := config.ConfigDir
	config.ConfigDir = t.TempDir()
	t.Cleanup(func() { config.ConfigDir = prev })

	info, err := buildTrust(config.Settings{ServerIP: "10.0.0.2", ProxyHTTPSPort: -1}, "10.0.0.2.nip.io", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if info.CA != dev.TLSFilesFor("10.0.0.2.nip.io").CA {
		t.Errorf("CA = %s", info.CA)
	}
	if _, err := os.Stat(info.CA); err != nil {
		t.Errorf("CA not created: %v", err)
	}
	if want, _ := dev.CAFingerprint(info.CA); info.Fingerprint != want || want == "" {
		t.Errorf("fingerprint = %q, want %q", info.Fingerprint, want)
	}
	if info.HTTPSPort != 0 || !info.ServerIPSet || info.PEMURL != "http://10.0.0.2.nip.io/crew-ca.pem" {
		t.Errorf("info = %+v", info)
	}
}

func TestMacTrustArgs(t *testing.T) {
	got := strings.Join(macTrustArgs("/Users/x", "/x/ca.pem"), " ")
	want := "add-trusted-cert -r trustRoot -p ssl -k /Users/x/Library/Keychains/login.keychain-db /x/ca.pem"
	if got != want {
		t.Errorf("argv = %s\nwant   %s", got, want)
	}
}

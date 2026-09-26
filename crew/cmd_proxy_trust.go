package main

import (
	"fmt"
	"os"
	osexec "os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
	"github.com/FurlanLuka/crew/crew/internal/dev"
)

// trustInfo is everything a device needs to trust the proxy's HTTPS: which
// CA, how to check it is the right one, and where a phone downloads it.
type trustInfo struct {
	Domain      string `json:"domain"`
	CA          string `json:"ca"`
	Fingerprint string `json:"fingerprint"`
	PEMURL      string `json:"pem_url"`
	HTTPSPort   int    `json:"https_port"`
	// ServerIPSet is false while the domain comes from the detected IP, which
	// can change — each domain has its own CA to trust.
	ServerIPSet bool `json:"server_ip_set"`
}

// macTrustArgs is the security(1) call that adds the CA to the login
// keychain as trusted for TLS. Pure.
func macTrustArgs(home, ca string) []string {
	return []string{"add-trusted-cert", "-r", "trustRoot", "-p", "ssl", "-k", filepath.Join(home, "Library", "Keychains", "login.keychain-db"), ca}
}

func runSecurity(args []string) error {
	debug.Log("dev", "security %s", strings.Join(args, " "))
	cmd := osexec.Command("security", args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return cmd.Run()
}

// renderTrust is the human form of `crew dev proxy trust`. Pure.
func renderTrust(t trustInfo) string {
	var b strings.Builder
	if t.HTTPSPort == 0 {
		b.WriteString("HTTPS is off (proxy_https_port = -1). Turn it on with: crew config set proxy_https_port 0\n\n")
	}
	fmt.Fprintf(&b, "crew's CA for %s\n", t.Domain)
	fmt.Fprintf(&b, "  file         %s\n", t.CA)
	fmt.Fprintf(&b, "  SHA-256      %s\n\n", t.Fingerprint)
	b.WriteString("Trust it once on every device that opens the proxy over HTTPS:\n\n")
	b.WriteString("  This Mac     crew dev proxy trust --install   (asks for your password)\n")
	fmt.Fprintf(&b, "  iPhone/iPad  open %s in Safari → Allow → Settings → Profile Downloaded → Install,\n", t.PEMURL)
	b.WriteString("               then Settings → General → About → Certificate Trust Settings → turn on crew local CA\n")
	fmt.Fprintf(&b, "  Android      open %s → install as a CA certificate (Settings → Security → Encryption & credentials)\n", t.PEMURL)
	b.WriteString("  Other Mac    download the file, then: security add-trusted-cert -r trustRoot -p ssl -k ~/Library/Keychains/login.keychain-db crew-ca.pem\n")
	b.WriteString("\nCheck the SHA-256 on the device matches the one above.\n")
	if !t.ServerIPSet {
		b.WriteString("\n! server_ip is not set, so the domain follows the detected IP and can change (LAN vs Tailscale).\n")
		b.WriteString("  Each domain has its own CA. Pin it: crew config set server_ip <ip>\n")
	}
	return b.String()
}

// buildTrust makes sure domain has its CA and gathers what a device needs to
// trust it.
func buildTrust(settings config.Settings, domain string, now time.Time) (trustInfo, error) {
	files, err := dev.EnsureTLS(domain, now)
	if err != nil {
		return trustInfo{}, err
	}
	fingerprint, err := dev.CAFingerprint(files.CA)
	if err != nil {
		return trustInfo{}, err
	}
	return trustInfo{
		Domain:      domain,
		CA:          files.CA,
		Fingerprint: fingerprint,
		PEMURL:      caDownloadURL(domain, settings.GetProxyPort()),
		HTTPSPort:   settings.GetProxyHTTPSPort(),
		ServerIPSet: settings.ServerIP != "",
	}, nil
}

// caDownloadURL is where a phone fetches the CA: plain HTTP, since it cannot
// trust HTTPS yet. Pure.
func caDownloadURL(domain string, port int) string {
	if port == 80 {
		return "http://" + domain + dev.CAFileRoute
	}
	return fmt.Sprintf("http://%s:%d%s", domain, port, dev.CAFileRoute)
}

func cmdDevProxyTrust() {
	install := false
	for _, arg := range os.Args[4:] {
		switch arg {
		case "--install":
			install = true
		default:
			fmt.Fprintf(os.Stderr, "Unknown flag '%s'\n", arg)
			os.Exit(1)
		}
	}
	settings := config.LoadSettings()
	info, err := buildTrust(settings, settings.GetDomain(dev.ResolveHostIP()), time.Now())
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	if install {
		home, err := os.UserHomeDir()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		if err := runSecurity(macTrustArgs(home, info.CA)); err != nil {
			fmt.Fprintf(os.Stderr, "Error: could not add the CA to the login keychain: %v\n", err)
			os.Exit(1)
		}
		fmt.Fprintf(human, "Trusted crew's CA for %s on this Mac.\n", info.Domain)
	}
	if jsonOutput {
		printJSON(info)
		return
	}
	if !install {
		fmt.Print(renderTrust(info))
	}
}

package dev

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
	"github.com/FurlanLuka/crew/crew/internal/debug"
)

const (
	caValidity = 10 * 365 * 24 * time.Hour
	// Apple rejects a server certificate valid for more than 398 days, even
	// from a CA the user trusted by hand.
	leafValidity = 397 * 24 * time.Hour
	leafRenewal  = 30 * 24 * time.Hour
	// CAFileRoute is where the proxy serves the CA over plain HTTP: a phone
	// has to fetch it before it can trust anything over HTTPS.
	CAFileRoute = "/crew-ca.pem"
)

// TLSFiles is where one domain's certificates live. Each domain keeps its own
// CA for good: when the detected host IP flips between LAN and Tailscale, the
// domain flips with it, and switching back must not ask every device to trust
// a new CA again.
type TLSFiles struct {
	Dir   string `json:"dir"`
	CA    string `json:"ca"`
	CAKey string `json:"-"`
	Cert  string `json:"cert"`
	Key   string `json:"-"`
}

func TLSFilesFor(domain string) TLSFiles {
	dir := filepath.Join(config.ConfigDir, "tls", domain)
	return TLSFiles{
		Dir:   dir,
		CA:    filepath.Join(dir, "ca.pem"),
		CAKey: filepath.Join(dir, "ca-key.pem"),
		Cert:  filepath.Join(dir, "cert.pem"),
		Key:   filepath.Join(dir, "key.pem"),
	}
}

type keyPair struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
}

// EnsureTLS makes sure domain has a CA and a current certificate for
// *.domain, creating or reissuing what is missing, unreadable or near expiry.
// A lock keeps two crew processes (the proxy and `crew dev proxy trust`) from
// writing a CA certificate beside the other's key.
func EnsureTLS(domain string, now time.Time) (TLSFiles, error) {
	files := TLSFilesFor(domain)
	if err := os.MkdirAll(files.Dir, 0o700); err != nil {
		return files, err
	}
	unlock, err := lockPath(filepath.Join(files.Dir, ".lock"))
	if err != nil {
		return files, err
	}
	defer unlock()

	ca, err := readKeyPair(files.CA, files.CAKey)
	if err != nil {
		debug.Log("dev", "tls: no usable CA for %s (%v) — creating one", domain, err)
		if ca, err = createCA(domain, now); err != nil {
			return files, err
		}
		if err := writeKeyPair(ca, files.CA, files.CAKey); err != nil {
			return files, err
		}
	}

	leaf, err := readKeyPair(files.Cert, files.Key)
	if err == nil && !needsLeaf(leaf.cert, ca.cert, domain, now) {
		return files, nil
	}
	debug.Log("dev", "tls: issuing the certificate for *.%s", domain)
	if leaf, err = issueLeaf(ca, domain, now); err != nil {
		return files, err
	}
	return files, writeKeyPair(leaf, files.Cert, files.Key)
}

// needsLeaf is whether the site certificate must be reissued: close to
// expiry, not signed by this CA, or not valid for the domain. Pure.
func needsLeaf(leaf, ca *x509.Certificate, domain string, now time.Time) bool {
	if leaf.NotAfter.Sub(now) < leafRenewal {
		return true
	}
	pool := x509.NewCertPool()
	pool.AddCert(ca)
	_, err := leaf.Verify(x509.VerifyOptions{DNSName: domain, Roots: pool, CurrentTime: now})
	return err != nil
}

func serial() (*big.Int, error) {
	return rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
}

// createCA makes a CA that can only vouch for domain and its subdomains:
// a device trusts it for the proxy, and a leaked key signs nothing else.
func createCA(domain string, now time.Time) (keyPair, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return keyPair{}, err
	}
	sn, err := serial()
	if err != nil {
		return keyPair{}, err
	}
	tmpl := &x509.Certificate{
		SerialNumber:                sn,
		Subject:                     pkix.Name{CommonName: "crew local CA (" + domain + ")", Organization: []string{"crew"}},
		NotBefore:                   now.Add(-time.Hour),
		NotAfter:                    now.Add(caValidity),
		IsCA:                        true,
		BasicConstraintsValid:       true,
		MaxPathLenZero:              true,
		KeyUsage:                    x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		PermittedDNSDomainsCritical: true,
		PermittedDNSDomains:         []string{domain},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return keyPair{}, err
	}
	cert, err := x509.ParseCertificate(der)
	return keyPair{cert: cert, key: key}, err
}

// issueLeaf signs the proxy's certificate: every hostname the proxy routes is
// one label under the domain, so *.domain plus the domain itself covers them.
func issueLeaf(ca keyPair, domain string, now time.Time) (keyPair, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return keyPair{}, err
	}
	sn, err := serial()
	if err != nil {
		return keyPair{}, err
	}
	tmpl := &x509.Certificate{
		SerialNumber: sn,
		Subject:      pkix.Name{CommonName: "*." + domain},
		DNSNames:     []string{"*." + domain, domain},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(leafValidity),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		return keyPair{}, err
	}
	cert, err := x509.ParseCertificate(der)
	return keyPair{cert: cert, key: key}, err
}

func readKeyPair(certPath, keyPath string) (keyPair, error) {
	certPEM, err := os.ReadFile(certPath)
	if err != nil {
		return keyPair{}, err
	}
	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		return keyPair{}, err
	}
	return parseKeyPair(certPEM, keyPEM)
}

// parseKeyPair reads a PEM certificate and its EC key, and refuses a pair
// whose key does not match the certificate. Pure.
func parseKeyPair(certPEM, keyPEM []byte) (keyPair, error) {
	cb, _ := pem.Decode(certPEM)
	if cb == nil || cb.Type != "CERTIFICATE" {
		return keyPair{}, errors.New("certificate is not PEM")
	}
	cert, err := x509.ParseCertificate(cb.Bytes)
	if err != nil {
		return keyPair{}, err
	}
	kb, _ := pem.Decode(keyPEM)
	if kb == nil {
		return keyPair{}, errors.New("key is not PEM")
	}
	key, err := x509.ParseECPrivateKey(kb.Bytes)
	if err != nil {
		return keyPair{}, err
	}
	pub, ok := cert.PublicKey.(*ecdsa.PublicKey)
	if !ok || !pub.Equal(&key.PublicKey) {
		return keyPair{}, errors.New("key does not match certificate")
	}
	return keyPair{cert: cert, key: key}, nil
}

// writeKeyPair writes the key before the certificate, each through a rename:
// a reader never sees a certificate without the key that goes with it.
func writeKeyPair(kp keyPair, certPath, keyPath string) error {
	keyDER, err := x509.MarshalECPrivateKey(kp.key)
	if err != nil {
		return err
	}
	if err := writeFileAtomic(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		return err
	}
	return writeFileAtomic(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: kp.cert.Raw}), 0o644)
}

func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

func lockPath(path string) (func(), error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("lock %s: %w", path, err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		f.Close()
		return nil, fmt.Errorf("lock %s: %w", path, err)
	}
	return func() {
		syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		f.Close()
	}, nil
}

// CAFingerprint is the SHA-256 of the CA certificate, colon-separated as
// iOS and macOS show it, so a device's prompt can be checked against it.
func CAFingerprint(caPath string) (string, error) {
	data, err := os.ReadFile(caPath)
	if err != nil {
		return "", err
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return "", errors.New("CA is not PEM")
	}
	sum := sha256.Sum256(block.Bytes)
	parts := make([]string, len(sum))
	for i, b := range sum {
		parts[i] = fmt.Sprintf("%02X", b)
	}
	return strings.Join(parts, ":"), nil
}

// certSource hands the TLS listener its certificate and reissues it in place
// when it nears expiry, so a proxy that runs for a year never serves an
// expired one.
type certSource struct {
	domain string
	now    func() time.Time
	mu     sync.Mutex
	cert   *tls.Certificate
}

func (s *certSource) get(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if s.cert != nil && s.cert.Leaf != nil && s.cert.Leaf.NotAfter.Sub(now) >= leafRenewal {
		return s.cert, nil
	}
	files, err := EnsureTLS(s.domain, now)
	if err != nil {
		return nil, err
	}
	cert, err := tls.LoadX509KeyPair(files.Cert, files.Key)
	if err != nil {
		return nil, err
	}
	s.cert = &cert
	return s.cert, nil
}

// TLSConfig serves the domain's certificate over HTTP/1.1 only: the proxy
// hijacks the connection for WebSockets, which an HTTP/2 stream cannot do.
func TLSConfig(domain string, now func() time.Time) *tls.Config {
	src := &certSource{domain: domain, now: now}
	return &tls.Config{GetCertificate: src.get, NextProtos: []string{"http/1.1"}, MinVersion: tls.VersionTLS12}
}

// tlsAnswers is proxyAnswers over TLS: crew's status page, served with a
// certificate crew's CA signed for domain. Anything else on the port fails.
func tlsAnswers(port int, domain string, wait time.Duration) bool {
	caPEM, err := os.ReadFile(TLSFilesFor(domain).CA)
	if err != nil {
		return false
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return false
	}
	client := &http.Client{
		Timeout: 500 * time.Millisecond,
		Transport: &http.Transport{
			DisableKeepAlives: true,
			TLSClientConfig:   &tls.Config{RootCAs: pool, ServerName: domain},
		},
	}
	deadline := time.Now().Add(wait)
	for {
		if resp, err := client.Get(fmt.Sprintf("https://127.0.0.1:%d/", port)); err == nil {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
			resp.Body.Close()
			if strings.Contains(string(body), proxyPageMarker) {
				return true
			}
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(100 * time.Millisecond)
	}
}

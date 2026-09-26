package dev

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"
)

const testDomain = "10.0.0.2.nip.io"

var t0 = time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)

func mustEnsure(t *testing.T, domain string, now time.Time) TLSFiles {
	t.Helper()
	files, err := EnsureTLS(domain, now)
	if err != nil {
		t.Fatalf("EnsureTLS(%s): %v", domain, err)
	}
	return files
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func loadPair(t *testing.T, certPath, keyPath string) keyPair {
	t.Helper()
	kp, err := readKeyPair(certPath, keyPath)
	if err != nil {
		t.Fatalf("read %s: %v", certPath, err)
	}
	return kp
}

func verifies(leaf, ca *x509.Certificate, name string, now time.Time) error {
	pool := x509.NewCertPool()
	pool.AddCert(ca)
	_, err := leaf.Verify(x509.VerifyOptions{DNSName: name, Roots: pool, CurrentTime: now})
	return err
}

func snapshot(t *testing.T, files TLSFiles) map[string][]byte {
	t.Helper()
	out := map[string][]byte{}
	for _, p := range []string{files.CA, files.CAKey, files.Cert, files.Key} {
		out[p] = mustRead(t, p)
	}
	return out
}

func TestEnsureTLS_CreatesThenReuses(t *testing.T) {
	setupTestConfig(t)
	files := mustEnsure(t, testDomain, t0)
	before := snapshot(t, files)

	mustEnsure(t, testDomain, t0.Add(24*time.Hour))
	for path, data := range snapshot(t, files) {
		if !bytes.Equal(data, before[path]) {
			t.Errorf("%s changed on a second call", filepath.Base(path))
		}
	}
}

func TestEnsureTLS_LeafCoversEveryProxyHostname(t *testing.T) {
	setupTestConfig(t)
	files := mustEnsure(t, testDomain, t0)
	ca := loadPair(t, files.CA, files.CAKey)
	leaf := loadPair(t, files.Cert, files.Key)

	for _, name := range []string{"voice--os." + testDomain, "api--store-front--wrk1." + testDomain, testDomain} {
		if err := verifies(leaf.cert, ca.cert, name, t0); err != nil {
			t.Errorf("leaf does not verify for %s: %v", name, err)
		}
	}
	if got := leaf.cert.NotAfter.Sub(leaf.cert.NotBefore); got > 398*24*time.Hour {
		t.Errorf("leaf valid for %s, Apple's limit is 398 days", got)
	}
	if got := ca.cert.NotAfter.Sub(t0); got < 9*365*24*time.Hour {
		t.Errorf("CA valid only %s", got)
	}
	if !ca.cert.IsCA || !ca.cert.BasicConstraintsValid || ca.cert.KeyUsage&x509.KeyUsageCertSign == 0 {
		t.Error("CA lacks the fields Apple devices require (IsCA, basic constraints, cert sign)")
	}
	if len(leaf.cert.ExtKeyUsage) != 1 || leaf.cert.ExtKeyUsage[0] != x509.ExtKeyUsageServerAuth {
		t.Errorf("leaf ExtKeyUsage = %v, want serverAuth", leaf.cert.ExtKeyUsage)
	}
}

func TestEnsureTLS_KeysArePrivate(t *testing.T) {
	setupTestConfig(t)
	files := mustEnsure(t, testDomain, t0)
	for _, p := range []string{files.CAKey, files.Key} {
		info, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Errorf("%s mode = %o, want 600", filepath.Base(p), info.Mode().Perm())
		}
	}
}

func TestEnsureTLS_RenewsLeafNearExpiry(t *testing.T) {
	setupTestConfig(t)
	files := mustEnsure(t, testDomain, t0)
	leaf := loadPair(t, files.Cert, files.Key)
	caBefore := mustRead(t, files.CA)

	// 31 days left: kept.
	mustEnsure(t, testDomain, leaf.cert.NotAfter.Add(-31*24*time.Hour))
	if got := loadPair(t, files.Cert, files.Key); !got.cert.Equal(leaf.cert) {
		t.Error("a leaf with 31 days left was reissued")
	}

	// 29 days left: reissued by the same CA.
	later := leaf.cert.NotAfter.Add(-29 * 24 * time.Hour)
	mustEnsure(t, testDomain, later)
	renewed := loadPair(t, files.Cert, files.Key)
	if renewed.cert.Equal(leaf.cert) {
		t.Fatal("a leaf with 29 days left was kept")
	}
	if !bytes.Equal(mustRead(t, files.CA), caBefore) {
		t.Error("renewing the leaf replaced the CA")
	}
	if err := verifies(renewed.cert, loadPair(t, files.CA, files.CAKey).cert, "voice--os."+testDomain, later); err != nil {
		t.Errorf("renewed leaf does not verify: %v", err)
	}
}

func TestEnsureTLS_OneCAPerDomainKeptForGood(t *testing.T) {
	setupTestConfig(t)
	first := mustEnsure(t, testDomain, t0)
	firstFiles := snapshot(t, first)

	other := mustEnsure(t, "100.64.0.9.nip.io", t0)
	if other.Dir == first.Dir {
		t.Fatal("two domains share one TLS directory")
	}
	if err := verifies(loadPair(t, other.Cert, other.Key).cert, loadPair(t, first.CA, first.CAKey).cert, "voice--os.100.64.0.9.nip.io", t0); err == nil {
		t.Error("the new domain's leaf verifies against the old domain's CA")
	}

	// Switching back reuses what devices already trust.
	mustEnsure(t, testDomain, t0)
	for path, data := range snapshot(t, first) {
		if !bytes.Equal(data, firstFiles[path]) {
			t.Errorf("switching back changed %s", filepath.Base(path))
		}
	}
}

// signFor has the CA sign a certificate for any name — what a leaked CA key
// could do, and what the name constraint must make worthless.
func signFor(t *testing.T, ca keyPair, name string) *x509.Certificate {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(99),
		Subject:      pkix.Name{CommonName: name},
		DNSNames:     []string{name},
		NotBefore:    t0.Add(-time.Hour),
		NotAfter:     t0.Add(24 * time.Hour),
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	return cert
}

func TestCA_CannotVouchForOtherSites(t *testing.T) {
	setupTestConfig(t)
	files := mustEnsure(t, testDomain, t0)
	ca := loadPair(t, files.CA, files.CAKey)
	for _, name := range []string{"other.example", "evil" + testDomain, "www.google.com"} {
		if err := verifies(signFor(t, ca, name), ca.cert, name, t0); err == nil {
			t.Errorf("a certificate the CA signed for %s verifies", name)
		}
	}
	if err := verifies(signFor(t, ca, "x."+testDomain), ca.cert, "x."+testDomain, t0); err != nil {
		t.Errorf("control: a name under the domain should verify: %v", err)
	}
}

func TestEnsureTLS_RepairsDamagedFiles(t *testing.T) {
	cases := []struct {
		name   string
		damage func(TLSFiles)
		keepCA bool
	}{
		{"unparsable leaf", func(f TLSFiles) { os.WriteFile(f.Cert, []byte("garbage"), 0o644) }, true},
		{"leaf key missing", func(f TLSFiles) { os.Remove(f.Key) }, true},
		{"leaf key from another pair", func(f TLSFiles) {
			k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
			writeKeyPair(keyPair{cert: loadPairNoT(f.Cert, f.Key).cert, key: k}, f.Cert, f.Key)
		}, true},
		{"garbled CA cert", func(f TLSFiles) { os.WriteFile(f.CA, []byte("garbage"), 0o644) }, false},
		{"CA key missing", func(f TLSFiles) { os.Remove(f.CAKey) }, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			setupTestConfig(t)
			files := mustEnsure(t, testDomain, t0)
			caBefore := mustRead(t, files.CA)
			c.damage(files)

			mustEnsure(t, testDomain, t0)
			ca := loadPair(t, files.CA, files.CAKey)
			leaf := loadPair(t, files.Cert, files.Key)
			if err := verifies(leaf.cert, ca.cert, "voice--os."+testDomain, t0); err != nil {
				t.Errorf("after repair the leaf does not verify: %v", err)
			}
			if kept := bytes.Equal(mustRead(t, files.CA), caBefore); kept != c.keepCA {
				t.Errorf("CA kept = %v, want %v", kept, c.keepCA)
			}
		})
	}
}

func loadPairNoT(certPath, keyPath string) keyPair {
	kp, _ := readKeyPair(certPath, keyPath)
	return kp
}

func TestCertSource_RenewsInPlace(t *testing.T) {
	setupTestConfig(t)
	now := t0
	src := &certSource{domain: testDomain, now: func() time.Time { return now }}
	first, err := src.get(&tls.ClientHelloInfo{})
	if err != nil {
		t.Fatal(err)
	}
	same, _ := src.get(&tls.ClientHelloInfo{})
	if same != first {
		t.Error("a fresh certificate was reloaded on the next handshake")
	}

	now = first.Leaf.NotAfter.Add(-10 * 24 * time.Hour)
	renewed, err := src.get(&tls.ClientHelloInfo{})
	if err != nil {
		t.Fatal(err)
	}
	if renewed.Leaf.Equal(first.Leaf) {
		t.Error("a certificate 10 days from expiry was still handed out")
	}
}

func TestCAFingerprint(t *testing.T) {
	setupTestConfig(t)
	files := mustEnsure(t, testDomain, t0)
	fp, err := CAFingerprint(files.CA)
	if err != nil {
		t.Fatal(err)
	}
	// 32 bytes as colon-separated uppercase hex, as iOS shows it.
	if len(fp) != 32*3-1 || fp[2] != ':' {
		t.Errorf("fingerprint = %q", fp)
	}
}

// The proxy and `crew dev proxy trust` can create a domain's CA at the same
// moment; the lock must leave one CA whose key matches, with a leaf it signed.
func TestEnsureTLS_ConcurrentCallersAgreeOnOneCA(t *testing.T) {
	setupTestConfig(t)
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		go func() {
			_, err := EnsureTLS(testDomain, t0)
			errs <- err
		}()
	}
	for i := 0; i < 8; i++ {
		if err := <-errs; err != nil {
			t.Fatalf("EnsureTLS: %v", err)
		}
	}
	files := TLSFilesFor(testDomain)
	ca := loadPair(t, files.CA, files.CAKey)
	if err := verifies(loadPair(t, files.Cert, files.Key).cert, ca.cert, "voice--os."+testDomain, t0); err != nil {
		t.Errorf("leaf does not verify against the CA on disk: %v", err)
	}
	before := snapshot(t, files)
	mustEnsure(t, testDomain, t0)
	for path, data := range snapshot(t, files) {
		if !bytes.Equal(data, before[path]) {
			t.Errorf("%s changed after the race settled", filepath.Base(path))
		}
	}
}

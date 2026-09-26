package dev

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// tlsProxy runs the proxy handler behind crew's TLS config, as `crew dev
// _proxy` does on the HTTPS port.
func tlsProxy(t *testing.T) (*httptest.Server, *x509.CertPool) {
	t.Helper()
	mustEnsure(t, testDomain, time.Now())
	srv := httptest.NewUnstartedServer(&proxyHandler{domain: testDomain, port: 80, httpsPort: 443})
	srv.TLS = TLSConfig(testDomain, time.Now)
	srv.StartTLS()
	t.Cleanup(srv.Close)

	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(mustRead(t, TLSFilesFor(testDomain).CA)) {
		t.Fatal("CA not PEM")
	}
	return srv, pool
}

// clientFor dials the test server whatever hostname the URL names, trusting
// only crew's CA — what a device does once it trusts the CA.
func clientFor(srv *httptest.Server, pool *x509.CertPool) *http.Client {
	addr := srv.Listener.Addr().String()
	return &http.Client{Transport: &http.Transport{
		TLSClientConfig: &tls.Config{RootCAs: pool},
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, addr)
		},
	}}
}

func portOf(t *testing.T, srv *httptest.Server) int {
	t.Helper()
	_, p, _ := net.SplitHostPort(srv.Listener.Addr().String())
	port, err := strconv.Atoi(p)
	if err != nil {
		t.Fatal(err)
	}
	return port
}

func TestProxyTLS_StatusPageTrustedByCrewCA(t *testing.T) {
	setupTestConfig(t)
	srv, pool := tlsProxy(t)

	resp, err := clientFor(srv, pool).Get("https://" + testDomain + "/")
	if err != nil {
		t.Fatalf("HTTPS with only crew's CA trusted: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), proxyPageMarker) {
		t.Errorf("status page not served over HTTPS: %q", body)
	}
	if resp.Proto != "HTTP/1.1" {
		t.Errorf("proto = %s, want HTTP/1.1 (WebSocket hijack needs it)", resp.Proto)
	}
}

// A WebSocket upgrade over TLS reaches the backend with the browser's Host and
// Origin untouched — Voice OS checks the Origin — and the proxy says it was
// TLS.
func TestProxyTLS_WebSocketReachesBackend(t *testing.T) {
	setupTestConfig(t)
	seen := make(chan http.Header, 1)
	hosts := make(chan string, 1)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Clone()
		hosts <- r.Host
		conn, buf, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		buf.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
		buf.Flush()
		line, _ := buf.ReadString('\n')
		conn.Write([]byte("echo " + line))
	}))
	defer backend.Close()
	if err := saveRoutes("os", []Route{{ServerName: "voice", ExternalPort: portOf(t, backend), InternalPort: portOf(t, backend)}}); err != nil {
		t.Fatal(err)
	}
	srv, pool := tlsProxy(t)

	host := "voice--os." + testDomain
	conn, err := tls.Dial("tcp", srv.Listener.Addr().String(), &tls.Config{RootCAs: pool, ServerName: host})
	if err != nil {
		t.Fatalf("TLS dial: %v", err)
	}
	defer conn.Close()
	conn.Write([]byte("GET /ws HTTP/1.1\r\nHost: " + host + "\r\nOrigin: https://" + host + "\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"))
	reader := bufio.NewReader(conn)
	status, _ := reader.ReadString('\n')
	if !strings.Contains(status, "101") {
		t.Fatalf("upgrade status = %q", status)
	}
	for line, _ := reader.ReadString('\n'); line != "\r\n" && line != ""; line, _ = reader.ReadString('\n') {
	}
	conn.Write([]byte("ping\n"))
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	echo, _ := reader.ReadString('\n')
	if echo != "echo ping\n" {
		t.Errorf("frames did not flow through: %q", echo)
	}

	h := <-seen
	if got := <-hosts; got != host {
		t.Errorf("backend Host = %q, want %q", got, host)
	}
	if got := h.Get("Origin"); got != "https://"+host {
		t.Errorf("backend Origin = %q", got)
	}
	if got := h.Get("X-Forwarded-Proto"); got != "https" {
		t.Errorf("X-Forwarded-Proto = %q, want https", got)
	}
}

func TestProxy_ServesCAOverPlainHTTP(t *testing.T) {
	setupTestConfig(t)
	h := &proxyHandler{domain: testDomain, port: 80, httpsPort: 443}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "http://"+testDomain+CAFileRoute, nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("before any CA exists: status %d, want 404", rec.Code)
	}

	files := mustEnsure(t, testDomain, time.Now())
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "http://"+testDomain+CAFileRoute, nil))
	if rec.Code != http.StatusOK || rec.Body.String() != string(mustRead(t, files.CA)) {
		t.Fatalf("CA download: status %d, body differs from %s", rec.Code, files.CA)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/x-x509-ca-cert" {
		t.Errorf("Content-Type = %q — iOS only offers to install this type", ct)
	}

	// A routed hostname's own /crew-ca.pem belongs to the app, not the proxy.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "http://voice--os."+testDomain+CAFileRoute, nil))
	if rec.Header().Get("Content-Type") == "application/x-x509-ca-cert" {
		t.Error("the proxy answered /crew-ca.pem on a routed hostname")
	}
}

func TestStatusPage_LinksHTTPSAndTheCA(t *testing.T) {
	setupTestConfig(t)
	if err := saveRoutes("store-front--wrk1", []Route{{ServerName: "web", ExternalPort: 3000, InternalPort: 41000}}); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	(&proxyHandler{domain: testDomain, port: 80, httpsPort: 443}).ServeHTTP(rec, httptest.NewRequest("GET", "http://10.0.0.2/", nil))
	body := rec.Body.String()
	for _, want := range []string{`href="https://web--store-front--wrk1.` + testDomain + `"`, `href="` + CAFileRoute + `"`} {
		if !strings.Contains(body, want) {
			t.Errorf("status page lacks %s", want)
		}
	}

	rec = httptest.NewRecorder()
	(&proxyHandler{domain: testDomain, port: 80}).ServeHTTP(rec, httptest.NewRequest("GET", "http://10.0.0.2/", nil))
	if strings.Contains(rec.Body.String(), "https://") {
		t.Error("with HTTPS off the page still links https")
	}
}

func TestTLSAnswers(t *testing.T) {
	setupTestConfig(t)
	srv, _ := tlsProxy(t)
	if !tlsAnswers(portOf(t, srv), testDomain, 0) {
		t.Error("crew's proxy over TLS not recognised")
	}

	plain := httptest.NewServer(&proxyHandler{domain: testDomain})
	defer plain.Close()
	if tlsAnswers(portOf(t, plain), testDomain, 0) {
		t.Error("a plain-HTTP listener was taken for HTTPS")
	}

	// A TLS server with some other certificate is not crew's proxy.
	foreign := httptest.NewTLSServer(&proxyHandler{domain: testDomain})
	defer foreign.Close()
	if tlsAnswers(portOf(t, foreign), testDomain, 0) {
		t.Error("a TLS server without crew's certificate was accepted")
	}
}

// When HTTPS cannot start, the reason is recorded and plain HTTP serves on.
func TestRunProxy_TLSFailureKeepsHTTP(t *testing.T) {
	setupTestConfig(t)
	// The certificates cannot be written: tls/ is a file.
	if err := os.WriteFile(filepath.Join(filepath.Dir(TLSFilesFor(testDomain).Dir)), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	httpPort, httpsPort := freePort(t), freePort(t)
	go RunProxy(testDomain, httpPort, httpsPort)

	if !proxyAnswers(httpPort, 3*time.Second) {
		t.Fatal("plain HTTP stopped because HTTPS failed")
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		st, _ := loadProxyState()
		if strings.Contains(st.TLSError, "certificate") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("TLS failure not recorded: %+v", st)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

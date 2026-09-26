package dev

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/debug"
)

// RunProxy starts the shared reverse proxy on port, and on httpsPort (0 =
// off) the same routes over TLS with a certificate from crew's own CA.
// Routes are hot-reloaded from route files on each request. A TLS failure is
// recorded and leaves plain HTTP serving: warn, never block.
func RunProxy(domain string, port, httpsPort int) error {
	if domain == "" {
		domain = ResolveHostIP() + ".nip.io"
	}

	handler := &proxyHandler{domain: domain, port: port, httpsPort: httpsPort}

	addr := fmt.Sprintf("0.0.0.0:%d", port)
	fmt.Printf("crew dev proxy\n")
	fmt.Printf("Listening on %s\n", addr)
	fmt.Printf("Domain: %s\n\n", domain)

	if httpsPort > 0 {
		go func() {
			if err := serveTLS(handler, domain, httpsPort); err != nil {
				fmt.Printf("HTTPS error: %v\n", err)
				debug.Log("dev", "proxy https on :%d failed: %v", httpsPort, err)
				RecordProxyTLSError(err)
			}
		}()
	}

	server := &http.Server{
		Addr:    addr,
		Handler: handler,
	}
	return server.ListenAndServe()
}

func serveTLS(handler http.Handler, domain string, port int) error {
	// Issued before listening, so a certificate problem is reported at once
	// rather than on the first handshake.
	if _, err := EnsureTLS(domain, time.Now()); err != nil {
		return fmt.Errorf("certificate: %w", err)
	}
	addr := fmt.Sprintf("0.0.0.0:%d", port)
	fmt.Printf("Listening on %s (HTTPS)\n", addr)
	server := &http.Server{Addr: addr, Handler: handler, TLSConfig: TLSConfig(domain, time.Now)}
	return server.ListenAndServeTLS("", "")
}

type proxyHandler struct {
	domain    string
	port      int
	httpsPort int
}

func (h *proxyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	serverName, slug := extractSubdomainParts(r.Host, h.domain)

	if serverName == "" || slug == "" {
		if r.URL.Path == CAFileRoute {
			h.serveCA(w)
			return
		}
		h.serveStatusPage(w, r)
		return
	}

	// Hot-reload: read routes fresh on each request
	allRoutes, err := ListAllRoutes()
	if err != nil {
		http.Error(w, "Failed to load routes", http.StatusInternalServerError)
		return
	}

	var target *Route
	for _, wr := range allRoutes {
		if wr.Slug != slug {
			continue
		}
		for i := range wr.Routes {
			if !wr.Routes[i].Proxied() {
				continue
			}
			if wr.Routes[i].ServerName == serverName {
				target = &wr.Routes[i]
				break
			}
		}
		if target != nil {
			break
		}
	}

	if target == nil {
		h.serveStatusPage(w, r)
		return
	}

	h.proxyTo(w, r, target.InternalPort)
}

// serveCA hands out the CA certificate — public by nature — as the type iOS
// and Android offer to install.
func (h *proxyHandler) serveCA(w http.ResponseWriter) {
	data, err := os.ReadFile(TLSFilesFor(h.domain).CA)
	if err != nil {
		http.Error(w, "crew has no CA for this domain yet: run crew dev proxy trust", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/x-x509-ca-cert")
	w.Header().Set("Content-Disposition", `attachment; filename="crew-ca.pem"`)
	w.Write(data)
}

func (h *proxyHandler) proxyTo(w http.ResponseWriter, r *http.Request, port int) {
	// Backends that build absolute URLs or check origins need to know the
	// browser came in over TLS.
	if r.TLS != nil {
		r.Header.Set("X-Forwarded-Proto", "https")
	}
	targetURL := &url.URL{
		Scheme: "http",
		Host:   fmt.Sprintf("127.0.0.1:%d", port),
	}
	if isWebSocketUpgrade(r) {
		h.handleWebSocket(w, r, targetURL)
		return
	}
	proxy := httputil.NewSingleHostReverseProxy(targetURL)
	proxy.ServeHTTP(w, r)
}

func (h *proxyHandler) handleWebSocket(w http.ResponseWriter, r *http.Request, target *url.URL) {
	targetAddr := target.Host

	backConn, err := net.Dial("tcp", targetAddr)
	if err != nil {
		http.Error(w, "Backend unavailable", http.StatusBadGateway)
		return
	}
	defer backConn.Close()

	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "WebSocket hijack not supported", http.StatusInternalServerError)
		return
	}

	clientConn, clientBuf, err := hijacker.Hijack()
	if err != nil {
		http.Error(w, "Hijack failed", http.StatusInternalServerError)
		return
	}
	defer clientConn.Close()

	// Forward the original request to the backend
	if err := r.Write(backConn); err != nil {
		return
	}

	// Flush any buffered data from the client
	if clientBuf.Reader.Buffered() > 0 {
		buffered := make([]byte, clientBuf.Reader.Buffered())
		clientBuf.Read(buffered)
		backConn.Write(buffered)
	}

	// Bidirectional copy
	done := make(chan struct{}, 2)
	go func() {
		io.Copy(clientConn, backConn)
		done <- struct{}{}
	}()
	go func() {
		io.Copy(backConn, clientConn)
		done <- struct{}{}
	}()
	<-done
}

// proxyPageMarker is how crew recognises its own proxy on a port: the
// status page carries it, nothing else on :80 does.
const proxyPageMarker = "crew dev proxy"

func (h *proxyHandler) serveStatusPage(w http.ResponseWriter, r *http.Request) {
	allRoutes, _ := ListAllRoutes()

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)

	fmt.Fprintf(w, `<!DOCTYPE html>
<html><head><title>`+proxyPageMarker+`</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; color: #333; }
  h1 { font-size: 1.4em; }
  a { color: #0066cc; }
  table { border-collapse: collapse; width: 100%%; margin-top: 16px; }
  td, th { text-align: left; padding: 6px 12px; border-bottom: 1px solid #eee; }
  th { font-weight: 600; border-bottom: 2px solid #ccc; }
</style>
</head><body>
<h1>crew dev proxy</h1>
<table>
<tr><th>Service</th><th>Worktree</th><th>URL</th></tr>
`)

	for _, wr := range allRoutes {
		for _, route := range wr.Routes {
			if !route.Proxied() {
				continue
			}
			u := RouteURL(route, wr.Slug, h.domain, h.port)
			secure := ""
			if h.httpsPort > 0 {
				s := FormatHTTPSURL(route.ServerName, wr.Slug, h.domain, h.httpsPort)
				secure = fmt.Sprintf(` · <a href="%s">https</a>`, s)
			}
			fmt.Fprintf(w, `<tr><td>%s</td><td>%s</td><td><a href="%s">%s</a>%s</td></tr>`+"\n",
				route.ServerName, DisplayRef(wr.Slug), u, u, secure)
		}
	}

	fmt.Fprintf(w, "</table>\n")
	if h.httpsPort > 0 {
		fmt.Fprintf(w, `<p>HTTPS uses crew's own certificate authority. Trust it once per device: <a href="%s">download crew-ca.pem</a>, or run <code>crew dev proxy trust</code> on the server for the steps.</p>`+"\n", CAFileRoute)
	}
	fmt.Fprintf(w, "</body></html>\n")
}

// extractSubdomainParts parses the subdomain from the Host header.
// e.g., "api--ws-a--wrk1.192.168.1.50.nip.io:8080" → ("api", "ws-a--wrk1")
func extractSubdomainParts(host, domain string) (serverName string, slug Slug) {
	h := host
	if idx := strings.LastIndex(h, ":"); idx != -1 {
		h = h[:idx]
	}

	suffix := "." + domain
	if !strings.HasSuffix(h, suffix) {
		return "", ""
	}

	sub := strings.TrimSuffix(h, suffix)
	parts := strings.SplitN(sub, "--", 2)
	if len(parts) != 2 {
		return "", ""
	}
	return parts[0], Slug(parts[1])
}

func isWebSocketUpgrade(r *http.Request) bool {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return false
	}
	for _, token := range strings.Split(r.Header.Get("Connection"), ",") {
		if strings.EqualFold(strings.TrimSpace(token), "upgrade") {
			return true
		}
	}
	return false
}

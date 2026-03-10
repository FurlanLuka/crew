package dev

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

// RunProxy starts the shared reverse proxy on a single port.
// Routes are hot-reloaded from route files on each request.
func RunProxy(domain string, port int) error {
	if domain == "" {
		domain = ResolveHostIP() + ".nip.io"
	}

	handler := &proxyHandler{domain: domain, port: port}

	addr := fmt.Sprintf("0.0.0.0:%d", port)
	fmt.Printf("crew dev proxy\n")
	fmt.Printf("Listening on %s\n", addr)
	fmt.Printf("Domain: %s\n\n", domain)

	server := &http.Server{
		Addr:    addr,
		Handler: handler,
	}
	return server.ListenAndServe()
}

type proxyHandler struct {
	domain string
	port   int
}

func (h *proxyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Check for plans subdomain (plans.{domain})
	if sub := extractSubdomain(r.Host, h.domain); sub == "plans" {
		if port := LoadPlansPort(); port > 0 {
			h.proxyTo(w, r, port)
			return
		}
		h.serveStatusPage(w, r)
		return
	}

	serverName, workspace := extractSubdomainParts(r.Host, h.domain)

	if serverName == "" || workspace == "" {
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
		if wr.Workspace != workspace {
			continue
		}
		for i := range wr.Routes {
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

func (h *proxyHandler) proxyTo(w http.ResponseWriter, r *http.Request, port int) {
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

func (h *proxyHandler) serveStatusPage(w http.ResponseWriter, r *http.Request) {
	allRoutes, _ := ListAllRoutes()

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)

	fmt.Fprintf(w, `<!DOCTYPE html>
<html><head><title>crew dev proxy</title>
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
<tr><th>Service</th><th>Workspace</th><th>URL</th></tr>
`)

	proxyPort := fmt.Sprintf("%d", h.port)

	// Show plans if running
	if port := LoadPlansPort(); port > 0 {
		u := fmt.Sprintf("http://plans.%s:%s", h.domain, proxyPort)
		fmt.Fprintf(w, `<tr><td>plans</td><td>—</td><td><a href="%s">%s</a></td></tr>`+"\n", u, u)
	}

	for _, wr := range allRoutes {
		for _, route := range wr.Routes {
			u := fmt.Sprintf("http://%s--%s.%s:%s", route.ServerName, wr.Workspace, h.domain, proxyPort)
			fmt.Fprintf(w, `<tr><td>%s</td><td>%s</td><td><a href="%s">%s</a></td></tr>`+"\n",
				route.ServerName, wr.Workspace, u, u)
		}
	}

	fmt.Fprintf(w, "</table></body></html>\n")
}

// extractSubdomain returns the full subdomain prefix before .{domain}.
// e.g., "plans.192.168.1.50.nip.io:8080" → "plans"
// e.g., "api--ws-a.192.168.1.50.nip.io:8080" → "api--ws-a"
func extractSubdomain(host, domain string) string {
	h := host
	if idx := strings.LastIndex(h, ":"); idx != -1 {
		h = h[:idx]
	}
	suffix := "." + domain
	if !strings.HasSuffix(h, suffix) {
		return ""
	}
	return strings.TrimSuffix(h, suffix)
}

// extractSubdomainParts parses the subdomain from the Host header.
// e.g., "api--ws-a.192.168.1.50.nip.io:8080" → ("api", "ws-a")
func extractSubdomainParts(host, domain string) (serverName, workspace string) {
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
	return parts[0], parts[1]
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

package dev

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
)

// RunProxy starts the reverse proxy, reading routes from the routes file.
// Blocks until all listeners are shut down.
func RunProxy(wsName, host string) error {
	routes, err := LoadRoutes(wsName)
	if err != nil {
		return fmt.Errorf("failed to load routes: %w", err)
	}
	if len(routes) == 0 {
		return fmt.Errorf("no routes found for workspace '%s'", wsName)
	}

	if host == "" {
		host = DetectLANIP()
	}

	// Group routes by external port
	portRoutes := make(map[int][]Route)
	for _, r := range routes {
		portRoutes[r.ExternalPort] = append(portRoutes[r.ExternalPort], r)
	}

	fmt.Printf("Proxy for workspace: %s\n", wsName)
	fmt.Printf("Host: %s\n\n", host)

	var wg sync.WaitGroup
	errCh := make(chan error, len(portRoutes))

	for port, pr := range portRoutes {
		wg.Add(1)
		go func(port int, routes []Route) {
			defer wg.Done()

			handler := &proxyHandler{
				host:   host,
				port:   port,
				routes: routes,
				all:    portRoutes,
			}

			addr := fmt.Sprintf("0.0.0.0:%d", port)
			fmt.Printf("Listening on %s\n", addr)

			server := &http.Server{
				Addr:    addr,
				Handler: handler,
			}
			if err := server.ListenAndServe(); err != nil {
				errCh <- fmt.Errorf("port %d: %w", port, err)
			}
		}(port, pr)
	}

	fmt.Println()
	for port, routes := range portRoutes {
		for _, r := range routes {
			fmt.Printf("  %s.%s.nip.io:%d -> 127.0.0.1:%d\n", r.Subdomain, host, port, r.InternalPort)
		}
	}
	fmt.Println()

	// Wait for any error (means a listener died)
	select {
	case err := <-errCh:
		return err
	}
}

type proxyHandler struct {
	host   string
	port   int
	routes []Route
	all    map[int][]Route
}

func (h *proxyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	subdomain := extractSubdomain(r.Host, h.host)

	if subdomain == "" {
		h.serveStatusPage(w, r)
		return
	}

	// Find matching route
	var target *Route
	for i := range h.routes {
		if h.routes[i].Subdomain == subdomain {
			target = &h.routes[i]
			break
		}
	}

	if target == nil {
		h.serveStatusPage(w, r)
		return
	}

	targetURL := &url.URL{
		Scheme: "http",
		Host:   fmt.Sprintf("127.0.0.1:%d", target.InternalPort),
	}

	// WebSocket upgrade — use raw TCP hijack
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
<tr><th>Worktree</th><th>Port</th><th>URL</th></tr>
`)

	for port, routes := range h.all {
		for _, r := range routes {
			u := fmt.Sprintf("http://%s.%s.nip.io:%d", r.Subdomain, h.host, port)
			fmt.Fprintf(w, `<tr><td>%s</td><td>%d</td><td><a href="%s">%s</a></td></tr>`+"\n",
				r.Subdomain, port, u, u)
		}
	}

	fmt.Fprintf(w, "</table></body></html>\n")
}

// extractSubdomain extracts the worktree name from the Host header.
// e.g., "feature-a.192.168.1.50.nip.io:5173" → "feature-a"
func extractSubdomain(host, baseIP string) string {
	// Strip port
	h := host
	if idx := strings.LastIndex(h, ":"); idx != -1 {
		h = h[:idx]
	}

	suffix := "." + baseIP + ".nip.io"
	if !strings.HasSuffix(h, suffix) {
		return ""
	}

	sub := strings.TrimSuffix(h, suffix)
	if sub == "" || strings.Contains(sub, ".") {
		return ""
	}
	return sub
}

func isWebSocketUpgrade(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Connection"), "upgrade") &&
		strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}

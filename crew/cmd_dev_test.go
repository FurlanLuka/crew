package main

import (
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/dev"
)

// firstProxied decides whether crew dev status warns about a dead proxy.
func TestFirstProxied(t *testing.T) {
	if got := firstProxied(nil); got != "" {
		t.Errorf("no routes → %q", got)
	}
	local := []dev.WsRoutes{{Slug: "ws--a", Routes: []dev.Route{{ServerName: "api", NoProxy: true}}}}
	if got := firstProxied(local); got != "" {
		t.Errorf("localhost only → %q", got)
	}
	// A server with no port has nothing to proxy either.
	worker := append(local, dev.WsRoutes{Slug: "ws--w", Routes: []dev.Route{{ServerName: "worker"}}})
	if got := firstProxied(worker); got != "" {
		t.Errorf("port-less only → %q", got)
	}
	mixed := append(worker, dev.WsRoutes{Slug: "ws--b", Routes: []dev.Route{{ServerName: "api", InternalPort: 54001}}})
	if got := firstProxied(mixed); got != "ws/b" {
		t.Errorf("mixed → %q, want ws/b", got)
	}
}

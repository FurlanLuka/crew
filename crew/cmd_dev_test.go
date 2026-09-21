package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/dev"
)

func TestDetectDevCommand(t *testing.T) {
	dir := t.TempDir()
	if got := detectDevCommand(dir); got != "" {
		t.Errorf("no package.json → %q", got)
	}
	os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"scripts":{"start":"node ."}}`), 0o644)
	if got := detectDevCommand(dir); got != "npm start" {
		t.Errorf("start only → %q", got)
	}
	os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"scripts":{"dev":"vite","start":"node ."}}`), 0o644)
	if got := detectDevCommand(dir); got != "npm run dev" {
		t.Errorf("dev wins → %q", got)
	}
	os.WriteFile(filepath.Join(dir, "package.json"), []byte(`not json`), 0o644)
	if got := detectDevCommand(dir); got != "" {
		t.Errorf("bad json → %q", got)
	}
}

// firstProxied decides whether crew dev status warns about a dead proxy.
func TestFirstProxied(t *testing.T) {
	if got := firstProxied(nil); got != "" {
		t.Errorf("no routes → %q", got)
	}
	local := []dev.WsRoutes{{Slug: "ws--a", Routes: []dev.Route{{ServerName: "api", NoProxy: true}}}}
	if got := firstProxied(local); got != "" {
		t.Errorf("localhost only → %q", got)
	}
	mixed := append(local, dev.WsRoutes{Slug: "ws--b", Routes: []dev.Route{{ServerName: "api"}}})
	if got := firstProxied(mixed); got != "ws/b" {
		t.Errorf("mixed → %q, want ws/b", got)
	}
}

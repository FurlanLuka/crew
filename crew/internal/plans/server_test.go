package plans

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/FurlanLuka/crew/crew/internal/config"
)

func setupPlansDir(t *testing.T) string {
	t.Helper()
	tmp := t.TempDir()
	config.ClaudeConfigDir = tmp

	dir := filepath.Join(tmp, "plans")
	os.MkdirAll(dir, 0o755)
	return dir
}

func TestScanPlans(t *testing.T) {
	dir := setupPlansDir(t)

	os.WriteFile(filepath.Join(dir, "plan-one.md"), []byte("# First Plan\nSome content"), 0o644)
	os.WriteFile(filepath.Join(dir, "plan-two.md"), []byte("No heading here"), 0o644)
	os.WriteFile(filepath.Join(dir, "not-markdown.txt"), []byte("ignored"), 0o644)

	plans, err := scanPlans()
	if err != nil {
		t.Fatalf("scanPlans: %v", err)
	}
	if len(plans) != 2 {
		t.Fatalf("got %d plans, want 2", len(plans))
	}

	byName := map[string]PlanMeta{}
	for _, p := range plans {
		byName[p.Filename] = p
	}

	p1 := byName["plan-one.md"]
	if p1.Title != "First Plan" {
		t.Errorf("plan-one title = %q, want %q", p1.Title, "First Plan")
	}

	p2 := byName["plan-two.md"]
	if p2.Title != "plan-two" {
		t.Errorf("plan-two title = %q, want %q", p2.Title, "plan-two")
	}
}

func TestScanPlans_EmptyDir(t *testing.T) {
	setupPlansDir(t)

	plans, err := scanPlans()
	if err != nil {
		t.Fatalf("scanPlans: %v", err)
	}
	if len(plans) != 0 {
		t.Errorf("got %d plans, want 0", len(plans))
	}
}

func TestScanPlans_MissingDir(t *testing.T) {
	tmp := t.TempDir()
	config.ClaudeConfigDir = tmp
	// Don't create the plans/ directory

	plans, err := scanPlans()
	if err != nil {
		t.Fatalf("scanPlans: %v", err)
	}
	if plans != nil {
		t.Errorf("got %v, want nil", plans)
	}
}

func TestExtractTitle(t *testing.T) {
	dir := t.TempDir()

	tests := []struct {
		name     string
		content  string
		filename string
		want     string
	}{
		{"heading present", "# My Plan\nContent", "test.md", "My Plan"},
		{"heading on line 3", "---\nfront matter\n# Deep Title\nContent", "test.md", "Deep Title"},
		{"no heading", "Just some text\nNo heading here", "fallback.md", "fallback"},
		{"empty file", "", "empty.md", "empty"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(dir, tt.filename)
			os.WriteFile(path, []byte(tt.content), 0o644)
			got := extractTitle(path)
			if got != tt.want {
				t.Errorf("extractTitle() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestHandleListPlans(t *testing.T) {
	dir := setupPlansDir(t)
	os.WriteFile(filepath.Join(dir, "test.md"), []byte("# Test Plan\nBody"), 0o644)

	req := httptest.NewRequest("GET", "/api/plans", nil)
	w := httptest.NewRecorder()
	handleListPlans(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}

	ct := w.Header().Get("Content-Type")
	if ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}

	var plans []PlanMeta
	if err := json.NewDecoder(w.Body).Decode(&plans); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(plans) != 1 {
		t.Fatalf("got %d plans, want 1", len(plans))
	}
	if plans[0].Title != "Test Plan" {
		t.Errorf("title = %q, want %q", plans[0].Title, "Test Plan")
	}
}

func TestHandleListPlans_Empty(t *testing.T) {
	setupPlansDir(t)

	req := httptest.NewRequest("GET", "/api/plans", nil)
	w := httptest.NewRecorder()
	handleListPlans(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}

	var plans []PlanMeta
	if err := json.NewDecoder(w.Body).Decode(&plans); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(plans) != 0 {
		t.Fatalf("got %d plans, want 0", len(plans))
	}
}

func TestHandleGetPlan(t *testing.T) {
	dir := setupPlansDir(t)
	os.WriteFile(filepath.Join(dir, "test.md"), []byte("# Hello\nWorld"), 0o644)

	srv := NewServer(0)
	ts := httptest.NewServer(srv.Handler)
	defer ts.Close()

	res, err := http.Get(ts.URL + "/api/plans/test.md")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}

	ct := res.Header.Get("Content-Type")
	if !strings.HasPrefix(ct, "text/markdown") {
		t.Errorf("Content-Type = %q, want text/markdown", ct)
	}
}

func TestHandleGetPlan_NotFound(t *testing.T) {
	setupPlansDir(t)

	srv := NewServer(0)
	ts := httptest.NewServer(srv.Handler)
	defer ts.Close()

	res, err := http.Get(ts.URL + "/api/plans/nonexistent.md")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404", res.StatusCode)
	}
}

func TestHandleGetPlan_PathTraversal(t *testing.T) {
	setupPlansDir(t)

	srv := NewServer(0)
	ts := httptest.NewServer(srv.Handler)
	defer ts.Close()

	res, err := http.Get(ts.URL + "/api/plans/..%2F..%2Fetc%2Fpasswd")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", res.StatusCode)
	}
}

func TestHandleIndex(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	w := httptest.NewRecorder()
	handleIndex(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}

	ct := w.Header().Get("Content-Type")
	if !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html", ct)
	}

	body := w.Body.String()
	if !strings.Contains(body, "<title>Plans</title>") {
		t.Error("response does not contain expected HTML title")
	}
}

func TestHandleIndex_NotFoundForOtherPaths(t *testing.T) {
	req := httptest.NewRequest("GET", "/favicon.ico", nil)
	w := httptest.NewRecorder()
	handleIndex(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", w.Code)
	}
}

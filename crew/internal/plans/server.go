package plans

import (
	"bufio"
	"embed"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/FurlanLuka/crew/crew/internal/config"
)

//go:embed index.html
var staticFS embed.FS

type PlanMeta struct {
	Filename string    `json:"filename"`
	Title    string    `json:"title"`
	Size     int64     `json:"size"`
	Modified time.Time `json:"modified"`
}

func plansDir() string {
	return filepath.Join(config.ClaudeConfigDir, "plans")
}

func scanPlans() ([]PlanMeta, error) {
	dir := plansDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var plans []PlanMeta
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		title := extractTitle(filepath.Join(dir, e.Name()))
		plans = append(plans, PlanMeta{
			Filename: e.Name(),
			Title:    title,
			Size:     info.Size(),
			Modified: info.ModTime().UTC(),
		})
	}
	return plans, nil
}

func extractTitle(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return filenameStem(filepath.Base(path))
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for i := 0; i < 10 && scanner.Scan(); i++ {
		line := scanner.Text()
		if strings.HasPrefix(line, "# ") {
			return strings.TrimSpace(line[2:])
		}
	}
	return filenameStem(filepath.Base(path))
}

func filenameStem(name string) string {
	ext := filepath.Ext(name)
	return name[:len(name)-len(ext)]
}

func NewServer(port int) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /", handleIndex)
	mux.HandleFunc("GET /api/plans", handleListPlans)
	mux.HandleFunc("GET /api/plans/{filename}", handleGetPlan)

	return &http.Server{
		Addr:    fmt.Sprintf(":%d", port),
		Handler: mux,
	}
}

func handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	data, _ := staticFS.ReadFile("index.html")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write(data)
}

func handleListPlans(w http.ResponseWriter, r *http.Request) {
	plans, err := scanPlans()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if plans == nil {
		plans = []PlanMeta{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(plans)
}

func handleGetPlan(w http.ResponseWriter, r *http.Request) {
	filename := r.PathValue("filename")

	if strings.Contains(filename, "..") || strings.Contains(filename, "/") || strings.Contains(filename, "\\") {
		http.Error(w, "invalid filename", http.StatusBadRequest)
		return
	}

	path := filepath.Join(plansDir(), filename)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			http.NotFound(w, r)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Write(data)
}

func RunServer(port int) error {
	srv := NewServer(port)
	fmt.Printf("Plan viewer listening on http://0.0.0.0:%d\n", port)
	return srv.ListenAndServe()
}

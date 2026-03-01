package project

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/FurlanLuka/crew/crew/internal/config"
)

// Project is a global project entry (no role — role is workspace-specific).
type Project struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

func poolFile() string {
	return filepath.Join(config.ConfigDir, "projects.json")
}

// List returns all projects from the global pool.
func List() ([]Project, error) {
	data, err := os.ReadFile(poolFile())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var projects []Project
	if err := json.Unmarshal(data, &projects); err != nil {
		return nil, err
	}
	return projects, nil
}

func save(projects []Project) error {
	data, err := json.MarshalIndent(projects, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(poolFile(), data, 0o644)
}

// Add adds a project to the global pool.
func Add(proj Project) error {
	projects, _ := List()
	projects = append(projects, proj)
	return save(projects)
}

// Remove removes a project by name from the global pool.
func Remove(name string) error {
	projects, err := List()
	if err != nil {
		return err
	}
	filtered := projects[:0]
	for _, p := range projects {
		if p.Name != name {
			filtered = append(filtered, p)
		}
	}
	return save(filtered)
}

// Get returns a project by name.
func Get(name string) *Project {
	projects, _ := List()
	for _, p := range projects {
		if p.Name == name {
			return &p
		}
	}
	return nil
}

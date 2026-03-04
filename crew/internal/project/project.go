package project

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/FurlanLuka/crew/crew/internal/config"
)

// DevServer describes how to run a dev server for a project.
type DevServer struct {
	Name    string `json:"name"`
	Port    int    `json:"port"`
	Command string `json:"command"`
	Dir     string `json:"dir,omitempty"`
}

// Project is a global project entry (no role — role is workspace-specific).
type Project struct {
	Name       string      `json:"name"`
	Path       string      `json:"path"`
	DevServers []DevServer `json:"dev_servers,omitempty"`
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
	projects, err := List()
	if err != nil {
		return err
	}
	for _, p := range projects {
		if p.Name == proj.Name {
			return fmt.Errorf("project '%s' already exists", proj.Name)
		}
	}
	projects = append(projects, proj)
	return save(projects)
}

// Remove removes a project by name from the global pool.
func Remove(name string) error {
	projects, err := List()
	if err != nil {
		return err
	}
	var filtered []Project
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

// Update saves changes to an existing project in the pool.
func Update(proj Project) error {
	projects, err := List()
	if err != nil {
		return err
	}
	for i, p := range projects {
		if p.Name == proj.Name {
			projects[i] = proj
			return save(projects)
		}
	}
	return fmt.Errorf("project '%s' not found", proj.Name)
}

// AddDevServer adds a dev server to a project in the pool.
func AddDevServer(projName string, ds DevServer) error {
	projects, err := List()
	if err != nil {
		return err
	}
	for i, p := range projects {
		if p.Name == projName {
			// Replace existing with same name, or append
			for j, existing := range p.DevServers {
				if existing.Name == ds.Name {
					projects[i].DevServers[j] = ds
					return save(projects)
				}
			}
			projects[i].DevServers = append(projects[i].DevServers, ds)
			return save(projects)
		}
	}
	return fmt.Errorf("project '%s' not found", projName)
}

// RemoveDevServer removes a dev server by name from a project in the pool.
func RemoveDevServer(projName, serverName string) error {
	projects, err := List()
	if err != nil {
		return err
	}
	for i, p := range projects {
		if p.Name == projName {
			var filtered []DevServer
			for _, ds := range p.DevServers {
				if ds.Name != serverName {
					filtered = append(filtered, ds)
				}
			}
			projects[i].DevServers = filtered
			return save(projects)
		}
	}
	return fmt.Errorf("project '%s' not found", projName)
}

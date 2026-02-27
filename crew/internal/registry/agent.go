package registry

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/FurlanLuka/homebrew-tap/crew/internal/config"
)

type AgentInfo struct {
	Name        string
	Description string
	Installed   bool
}

// ListAgents returns all agents from the registry with install status.
func ListAgents() ([]AgentInfo, error) {
	entries, err := FetchContents(config.RegistryBase + "/agents")
	if err != nil {
		return nil, err
	}

	var agents []AgentInfo
	for _, e := range entries {
		if e.Type != "file" || !strings.HasSuffix(e.Name, ".md") {
			continue
		}
		name := strings.TrimSuffix(e.Name, ".md")
		agents = append(agents, AgentInfo{
			Name:      name,
			Installed: isAgentInstalled(name),
		})
	}

	// Fetch descriptions
	for i, a := range agents {
		content, err := FetchRaw(config.RegistryBase + "/agents/" + a.Name + ".md")
		if err == nil {
			agents[i].Description = ParseFrontmatter(content, "description")
		}
	}

	return agents, nil
}

// InstalledAgents returns locally installed agent names.
func InstalledAgents() []AgentInfo {
	dir := filepath.Join(config.ClaudeConfigDir, "agents")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}

	var agents []AgentInfo
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		name := strings.TrimSuffix(e.Name(), ".md")
		desc := ""
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err == nil {
			desc = ParseFrontmatter(string(data), "description")
		}
		agents = append(agents, AgentInfo{Name: name, Description: desc, Installed: true})
	}
	return agents
}

// InstallAgent downloads and installs an agent.
func InstallAgent(name string) error {
	content, err := FetchRaw(config.RegistryBase + "/agents/" + name + ".md")
	if err != nil {
		return err
	}

	dir := filepath.Join(config.ClaudeConfigDir, "agents")
	os.MkdirAll(dir, 0o755)
	return os.WriteFile(filepath.Join(dir, name+".md"), []byte(content), 0o644)
}

// RemoveAgent removes an installed agent.
func RemoveAgent(name string) error {
	return os.Remove(filepath.Join(config.ClaudeConfigDir, "agents", name+".md"))
}

// UpdateAgent updates an agent if changed. Returns true if updated.
func UpdateAgent(name string) (bool, error) {
	local := filepath.Join(config.ClaudeConfigDir, "agents", name+".md")
	localData, err := os.ReadFile(local)
	if err != nil {
		return false, err
	}

	remote, err := FetchRaw(config.RegistryBase + "/agents/" + name + ".md")
	if err != nil {
		return false, err
	}

	if ContentHash(string(localData)) == ContentHash(remote) {
		return false, nil
	}

	err = os.WriteFile(local, []byte(remote), 0o644)
	return err == nil, err
}

func isAgentInstalled(name string) bool {
	_, err := os.Stat(filepath.Join(config.ClaudeConfigDir, "agents", name+".md"))
	return err == nil
}
